"""
GStreamer pipeline builder for ROS2 image topics.
Supports VP8, VP9, H264, H265 encoding with timestamp injection.

Uses webrtcbin for WebRTC transport (GstWebRTC).
"""

import gi
gi.require_version('Gst', '1.0')
gi.require_version('GstWebRTC', '1.0')
gi.require_version('GstSdp', '1.0')
from gi.repository import Gst, GstWebRTC, GstSdp, GLib

import time
import logging

logger = logging.getLogger(__name__)

# Codec configuration: encoder element, RTP payloader, caps
CODEC_CONFIG = {
    "vp8": {
        "encoder": "vp8enc",
        "encoder_props": {
            "deadline": 1,          # realtime
            "cpu-used": 8,          # fastest encoding
            "target-bitrate": 2000000,
            "keyframe-max-dist": 60,
        },
        "payloader": "rtpvp8pay",
        "encoding_name": "VP8",
        "clock_rate": 90000,
        "payload_type": 96,
    },
    "vp9": {
        "encoder": "vp9enc",
        "encoder_props": {
            "deadline": 1,
            "cpu-used": 8,
            "target-bitrate": 2000000,
            "keyframe-max-dist": 60,
        },
        "payloader": "rtpvp9pay",
        "encoding_name": "VP9",
        "clock_rate": 90000,
        "payload_type": 97,
    },
    "h264": {
        "encoder": "x264enc",
        "encoder_props": {
            "tune": 4,             # zerolatency
            "speed-preset": 1,     # ultrafast
            "bitrate": 2000,
            "key-int-max": 60,
        },
        "payloader": "rtph264pay",
        "payloader_props": {
            "config-interval": -1,
            "aggregate-mode": 1,    # zero-latency
        },
        "encoding_name": "H264",
        "clock_rate": 90000,
        "payload_type": 96,
    },
    "h265": {
        "encoder": "x265enc",
        "encoder_props": {
            "tune": 4,
            "speed-preset": 1,
            "bitrate": 2000,
            "key-int-max": 60,
        },
        "payloader": "rtph265pay",
        "payloader_props": {
            "config-interval": -1,
        },
        "encoding_name": "H265",
        "clock_rate": 90000,
        "payload_type": 99,
    },
}


class GstPipelineBuilder:
    """Builds GStreamer pipelines for encoding ROS2 camera frames."""

    def __init__(self, codec: str, width: int = 640, height: int = 480, fps: int = 30):
        if codec.lower() not in CODEC_CONFIG:
            raise ValueError(f"Unsupported codec: {codec}. Choose from: {list(CODEC_CONFIG.keys())}")

        self.codec = codec.lower()
        self.config = CODEC_CONFIG[self.codec]
        self.width = width
        self.height = height
        self.fps = fps
        self.pipeline = None
        self.appsrc = None
        self.webrtcbin = None

        # Timestamp tracking — probe-based EMA averages
        # Probes measure real encode/packetize time; we track rolling averages
        # because PTS values can change through the pipeline (B-frame reorder,
        # RTP payloader timestamp conversion), making per-frame PTS matching
        # unreliable.
        self._enc_sink_last_ns = 0       # last encoder-sink probe time (monotonic)
        self._enc_src_last_ns = 0        # last encoder-src probe time (monotonic)
        self._pay_src_last_ns = 0        # last payloader-src probe time (monotonic)
        self._encode_time_ema = 0.0      # EMA of encode time (ms)
        self._packetize_time_ema = 0.0   # EMA of packetize time (ms)
        self._probe_frame_count = 0      # frames seen by probes (for initial averaging)
        self._frame_counter = 0
        self._push_ok_count = 0
        self._push_err_count = 0

        # Running-time base: first frame's capture timestamp becomes PTS=0.
        # Without this, ROS2 wall-clock nanoseconds (e.g. 1.7e18) are set as
        # PTS, which GStreamer rejects because its running time starts at 0.
        self._pts_base_ns = None

        # Callback fired per frame with timing data.
        # Signature: on_frame_timed(stream_id, timing_dict)
        self.on_frame_timed = None

    def create_pipeline(self, stream_id: str) -> Gst.Pipeline:
        """Create and configure the GStreamer pipeline."""
        Gst.init(None)

        enc = self.config["encoder"]
        pay = self.config["payloader"]
        enc_name = self.config["encoding_name"]
        pt = self.config["payload_type"]
        clk = self.config["clock_rate"]

        # Pipeline: appsrc → videoconvert → encoder → payloader → webrtcbin
        # Use dot notation: declare webrtcbin first, then link chain to it via 'name.'
        webrtc_name = f"webrtc_{stream_id}"
        pipeline_str = (
            f'webrtcbin name={webrtc_name} bundle-policy=max-bundle '
            f'appsrc name=source_{stream_id} is-live=true format=time '
            f'caps=video/x-raw,format=RGB,width={self.width},height={self.height},'
            f'framerate={self.fps}/1 '
            f'! videoconvert '
            f'! video/x-raw,format=I420 '
            f'! {enc} name=encoder_{stream_id} '
            f'! {pay} name=payloader_{stream_id} '
            f'! queue '
            f'! application/x-rtp,media=video,encoding-name={enc_name},'
            f'payload={pt},clock-rate={clk} '
            f'! {webrtc_name}.'
        )

        logger.info(f"Creating pipeline for stream '{stream_id}'")
        logger.info(f"  Pipeline: {pipeline_str}")

        try:
            self.pipeline = Gst.parse_launch(pipeline_str)
        except GLib.GError as e:
            logger.error(f"parse_launch failed: {e.message}")
            logger.error("Trying fallback: inline linking (without dot notation)")
            # Fallback: inline linking
            pipeline_str_fallback = (
                f'appsrc name=source_{stream_id} is-live=true format=time '
                f'caps=video/x-raw,format=RGB,width={self.width},height={self.height},'
                f'framerate={self.fps}/1 '
                f'! videoconvert '
                f'! video/x-raw,format=I420 '
                f'! {enc} name=encoder_{stream_id} '
                f'! {pay} name=payloader_{stream_id} '
                f'! application/x-rtp,media=video,encoding-name={enc_name},'
                f'payload={pt},clock-rate={clk} '
                f'! webrtcbin name={webrtc_name} bundle-policy=max-bundle'
            )
            logger.info(f"  Fallback pipeline: {pipeline_str_fallback}")
            self.pipeline = Gst.parse_launch(pipeline_str_fallback)

        # Get element references
        self.appsrc = self.pipeline.get_by_name(f"source_{stream_id}")
        self.webrtcbin = self.pipeline.get_by_name(webrtc_name)
        encoder = self.pipeline.get_by_name(f"encoder_{stream_id}")
        payloader = self.pipeline.get_by_name(f"payloader_{stream_id}")

        if not self.appsrc:
            raise RuntimeError("appsrc not found in pipeline")
        if not self.webrtcbin:
            raise RuntimeError("webrtcbin not found in pipeline")
        if not encoder:
            raise RuntimeError("encoder not found in pipeline")

        logger.info(f"  Elements: appsrc={self.appsrc is not None}, "
                     f"encoder={encoder is not None}, "
                     f"payloader={payloader is not None}, "
                     f"webrtcbin={self.webrtcbin is not None}")

        # Apply encoder properties
        for prop, val in self.config["encoder_props"].items():
            try:
                encoder.set_property(prop, val)
            except Exception as e:
                logger.warning(f"Could not set encoder prop {prop}={val}: {e}")

        # Apply payloader properties if any
        if "payloader_props" in self.config and payloader:
            for prop, val in self.config["payloader_props"].items():
                try:
                    payloader.set_property(prop, val)
                except Exception as e:
                    logger.warning(f"Could not set payloader prop {prop}={val}: {e}")

        # Add probe on encoder sink pad for encode-start timestamp
        encoder_sink = encoder.get_static_pad("sink")
        if encoder_sink:
            encoder_sink.add_probe(
                Gst.PadProbeType.BUFFER,
                self._on_encode_start,
                stream_id
            )

        # Add probe on encoder src pad for encode-complete timestamp
        encoder_src = encoder.get_static_pad("src")
        if encoder_src:
            encoder_src.add_probe(
                Gst.PadProbeType.BUFFER,
                self._on_encode_complete,
                stream_id
            )

        # Add probe on payloader src pad — final timing before webrtcbin
        if payloader:
            payloader_src = payloader.get_static_pad("src")
            if payloader_src:
                payloader_src.add_probe(
                    Gst.PadProbeType.BUFFER,
                    self._on_packetized,
                    stream_id
                )

        # --- Pipeline bus monitoring ---
        # Watch for errors/warnings that indicate linking or data flow issues
        bus = self.pipeline.get_bus()
        bus.add_signal_watch()
        bus.connect("message::error", self._on_bus_error, stream_id)
        bus.connect("message::warning", self._on_bus_warning, stream_id)
        bus.connect("message::state-changed", self._on_bus_state, stream_id)

        # Check webrtcbin sink pads
        self._log_webrtcbin_pads(stream_id)

        return self.pipeline

    def _log_webrtcbin_pads(self, stream_id: str):
        """Log webrtcbin's current pads — helps debug linking issues."""
        if not self.webrtcbin:
            return
        pads = []
        it = self.webrtcbin.iterate_pads()
        while True:
            ok, pad = it.next()
            if ok != Gst.IteratorResult.OK:
                break
            caps = pad.get_current_caps()
            caps_str = caps.to_string() if caps else "no-caps"
            pads.append(f"{pad.get_name()}({pad.get_direction()}): {caps_str}")

        if pads:
            logger.info(f"  webrtcbin pads: {pads}")
        else:
            logger.warning(f"  webrtcbin has NO pads — linking may have failed!")

    def _on_bus_error(self, bus, msg, stream_id):
        err, debug = msg.parse_error()
        logger.error(f"[GST ERROR] {stream_id}: {err.message}")
        logger.error(f"  debug: {debug}")

    def _on_bus_warning(self, bus, msg, stream_id):
        warn, debug = msg.parse_warning()
        logger.warning(f"[GST WARNING] {stream_id}: {warn.message}")
        logger.warning(f"  debug: {debug}")

    def _on_bus_state(self, bus, msg, stream_id):
        if msg.src == self.pipeline:
            old, new, pending = msg.parse_state_changed()
            logger.info(f"[GST STATE] {stream_id}: {old.value_nick} → {new.value_nick}")
            # When pipeline reaches PLAYING, check pads again
            if new == Gst.State.PLAYING:
                self._log_webrtcbin_pads(stream_id)

    def push_frame(self, frame_data: bytes, capture_timestamp_ns: int, stream_id: str = ""):
        """Push a raw frame into the pipeline with running-time PTS.

        capture_timestamp_ns is the ROS2 wall-clock capture time (nanoseconds).
        We convert it to running time (relative to first frame) because
        GStreamer's pipeline clock starts at 0. Using raw ROS2 timestamps
        (e.g. 1.7e18 ns since Unix epoch) causes the encoder to drop every
        frame since the PTS is astronomically far from the pipeline clock.
        """
        if not self.appsrc:
            logger.error("Pipeline not created yet")
            return

        wall_ms = time.time() * 1000

        # Compute running-time PTS
        if self._pts_base_ns is None:
            self._pts_base_ns = capture_timestamp_ns
            logger.info(f"PTS base set: {self._pts_base_ns} ns "
                        f"(wall-clock offset from epoch)")

        running_pts = capture_timestamp_ns - self._pts_base_ns
        if running_pts < 0:
            running_pts = 0

        buf = Gst.Buffer.new_allocate(None, len(frame_data), None)
        buf.fill(0, frame_data)

        buf.pts = running_pts
        buf.dts = running_pts
        buf.duration = Gst.SECOND // self.fps

        self._frame_counter += 1

        ret = self.appsrc.emit("push-buffer", buf)
        if ret == Gst.FlowReturn.OK:
            self._push_ok_count += 1
        else:
            self._push_err_count += 1
            if self._push_err_count <= 5:
                logger.warning(f"Push buffer returned {ret} "
                               f"(frame={self._frame_counter}, pts={running_pts}ns)")

        # Periodic status
        if self._frame_counter % 300 == 0:
            logger.info(f"[FRAMES] pushed={self._frame_counter}, "
                        f"ok={self._push_ok_count}, err={self._push_err_count}, "
                        f"pts={running_pts/1e6:.1f}ms, "
                        f"enc_ema={self._encode_time_ema:.1f}ms, "
                        f"pkt_ema={self._packetize_time_ema:.1f}ms")

        # Fire timing callback directly from the frame thread.
        # Uses probe-measured EMA values for encode/packetize timing.
        # This is reliable because it doesn't depend on PTS matching
        # across pipeline elements (which fails with B-frames, RTP
        # timestamp conversion, and payloader packet splitting).
        if self.on_frame_timed and stream_id:
            enc_ms = self._encode_time_ema
            pkt_ms = self._packetize_time_ema
            self.on_frame_timed(stream_id, {
                "fid": self._frame_counter,
                "enc": round(enc_ms, 3),
                "pkt": round(pkt_ms, 3),
                "spl": round(enc_ms + pkt_ms, 3),
                "wst": round(wall_ms, 3),
                "t": round(wall_ms, 3),
            })

    def _on_encode_start(self, pad, info, stream_id):
        """Probe on encoder SINK: records when frame enters encoder."""
        buf = info.get_buffer()
        if buf:
            self._enc_sink_last_ns = time.monotonic_ns()
        return Gst.PadProbeReturn.OK

    def _on_encode_complete(self, pad, info, stream_id):
        """Probe on encoder SRC: records when frame exits encoder.
        
        Computes real encode time and updates EMA.
        """
        buf = info.get_buffer()
        if not buf:
            return Gst.PadProbeReturn.OK

        now_ns = time.monotonic_ns()
        self._enc_src_last_ns = now_ns

        if self._enc_sink_last_ns > 0:
            encode_ms = (now_ns - self._enc_sink_last_ns) / 1_000_000
            # Sanity check: encode shouldn't take more than 500ms
            if 0 < encode_ms < 500:
                self._probe_frame_count += 1
                if self._probe_frame_count <= 5:
                    # Use raw value for first few samples
                    self._encode_time_ema = encode_ms
                else:
                    self._encode_time_ema = 0.2 * encode_ms + 0.8 * self._encode_time_ema

                if self._probe_frame_count == 1:
                    logger.info(f"[PROBE] First encode measurement: {encode_ms:.1f}ms")

        return Gst.PadProbeReturn.OK

    def _on_packetized(self, pad, info, stream_id):
        """Probe on payloader SRC: measures packetization time.
        
        Computes time from encoder output to payloader output and updates EMA.
        Note: fires multiple times per frame (one per RTP packet), but timing
        is relative to the last encoder output so it's still correct.
        """
        buf = info.get_buffer()
        if not buf:
            return Gst.PadProbeReturn.OK

        now_ns = time.monotonic_ns()

        if self._enc_src_last_ns > 0:
            pkt_ms = (now_ns - self._enc_src_last_ns) / 1_000_000
            # Sanity check
            if 0 <= pkt_ms < 200:
                if self._probe_frame_count <= 5:
                    self._packetize_time_ema = pkt_ms
                else:
                    self._packetize_time_ema = 0.2 * pkt_ms + 0.8 * self._packetize_time_ema

        return Gst.PadProbeReturn.OK

    def start(self):
        if self.pipeline:
            ret = self.pipeline.set_state(Gst.State.PLAYING)
            logger.info(f"Pipeline set_state(PLAYING) returned: {ret}")

    def stop(self):
        if self.pipeline:
            self.pipeline.set_state(Gst.State.NULL)
            logger.info("Pipeline stopped")