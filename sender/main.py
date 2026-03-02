#!/usr/bin/env python3
"""
WebRTC GStreamer Sender - Main Entry Point

Subscribes to multiple ROS2 image topics, encodes with user-selected codec,
and streams via WebRTC (GstWebRTC webrtcbin) with per-frame timestamp tracking.

Usage:
    python main.py --codec h264 --topics /camera/front /camera/rear
    python main.py --codec vp8 --topics /cam1 --signaling ws://localhost:8080
    python main.py --codec h265 --width 1280 --height 720 --simulate
"""

import argparse
import asyncio
import json
import logging
import signal
import sys
import threading
import time

import gi
gi.require_version('Gst', '1.0')
from gi.repository import Gst, GLib

from gst_pipeline import GstPipelineBuilder, CODEC_CONFIG
from ros2_bridge import ROS2CameraBridge
from webrtc_sender import WebRTCSender
from timestamp import TimestampTracker

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(name)s] %(levelname)s: %(message)s',
    datefmt='%H:%M:%S'
)
logger = logging.getLogger(__name__)


class VideoSenderApp:
    """Main application that wires together ROS2, GStreamer, and WebRTC."""

    def __init__(self, args):
        self.args = args
        self.codec = args.codec.lower()
        self.topics = args.topics
        self.width = args.width
        self.height = args.height
        self.fps = args.fps
        self.signaling_url = args.signaling

        # Components
        self.pipelines: dict = {}
        self.pipeline_builders: dict = {}
        self.webrtc_sender = WebRTCSender(self.signaling_url, sender_id="ros2_gst_sender")
        self.timestamp_tracker = TimestampTracker()
        self.ros2_bridge = ROS2CameraBridge(self.topics, self.width, self.height)

        # GLib main loop for GStreamer
        self.glib_loop = GLib.MainLoop()
        self._running = False

    def _create_stream_id(self, topic: str) -> str:
        """Create a clean stream ID from a ROS2 topic name."""
        return topic.strip('/').replace('/', '_')

    def setup(self):
        """Initialize all pipelines (but don't start them yet)."""
        Gst.init(None)

        logger.info("=== WebRTC GStreamer Sender ===")
        logger.info(f"Codec:      {self.codec.upper()}")
        logger.info(f"Topics:     {self.topics}")
        logger.info(f"Resolution: {self.width}x{self.height} @ {self.fps}fps")
        logger.info(f"Signaling:  {self.signaling_url}")
        logger.info(f"Transport:  GstWebRTC (webrtcbin)")
        logger.info("===============================")

        for topic in self.topics:
            stream_id = self._create_stream_id(topic)
            logger.info(f"Setting up stream: {stream_id} (topic: {topic})")

            # Build GStreamer pipeline
            builder = GstPipelineBuilder(
                codec=self.codec,
                width=self.width,
                height=self.height,
                fps=self.fps
            )
            pipeline = builder.create_pipeline(stream_id)
            self.pipeline_builders[stream_id] = builder
            self.pipelines[stream_id] = pipeline

            # Register with WebRTC sender (sets STUN, connects signals)
            self.webrtc_sender.register_pipeline(
                stream_id, pipeline, builder.webrtcbin
            )

            # Wire up the timing callback.
            # push_frame fires this directly after each frame push,
            # with EMA-averaged encode/packetize times from GStreamer probes.
            builder.on_frame_timed = self._on_frame_timed

            # Register frame callback from ROS2 bridge
            self.ros2_bridge.register_callback(
                topic,
                lambda frame_bytes, capture_ts, sid=stream_id, b=builder:
                    self._on_frame(sid, b, frame_bytes, capture_ts)
            )

    def _on_frame(self, stream_id: str, builder: GstPipelineBuilder,
                   frame_bytes: bytes, capture_ts_ns: int):
        """Handle a new frame from ROS2: push to GStreamer pipeline.
        
        push_frame() will fire on_frame_timed callback with timing data.
        """
        builder.push_frame(frame_bytes, capture_ts_ns, stream_id)

    def _on_frame_timed(self, stream_id: str, timing: dict):
        """Called from push_frame with per-frame timing data.
        
        Fires from the ROS2 callback thread with EMA-averaged values:
        - enc: average encoder time (from GStreamer encoder pad probes)
        - pkt: average packetization time (from payloader pad probes)
        - spl: enc + pkt
        - wst: wall clock time at push
        """
        timing["type"] = "frame_ts"
        timing["sid"] = stream_id

        # Log periodically to confirm timing pipeline works
        fid = timing.get("fid", 0)
        if fid == 1 or (fid % 300 == 0):
            logger.info(f"[TIMING] {stream_id}: enc={timing.get('enc')}ms "
                        f"pkt={timing.get('pkt')}ms spl={timing.get('spl')}ms "
                        f"dc_open={stream_id in self.webrtc_sender._dc_open}")

        if stream_id in self.webrtc_sender._dc_open:
            dc = self.webrtc_sender.data_channels.get(stream_id)
            if dc:
                try:
                    dc.emit('send-string', json.dumps(timing))
                except Exception as e:
                    logger.warning(f"Failed to send timing for {stream_id}: {e}")

    async def run_async(self):
        """Run the async components (signaling, WebRTC).

        IMPORTANT: webrtc_sender.run() handles:
          1. Setting the event loop (so GStreamer thread can send via WS)
          2. Connecting to signaling server (ONCE)
          3. Running the keep-alive loop

        We must NOT call connect_signaling() separately — that causes
        a double WebSocket connection which leads to duplicate offers.
        """
        self._running = True

        # Step 1: Set the event loop on webrtc_sender BEFORE starting pipelines.
        # GStreamer's on-negotiation-needed and on-ice-candidate fire from
        # the GLib thread. They need self.loop to send via WebSocket.
        self.webrtc_sender.loop = asyncio.get_event_loop()
        logger.info("Event loop set for GStreamer thread callbacks")

        # Step 2: Connect to signaling (ONCE)
        await self.webrtc_sender.connect_signaling()

        # Step 3: Start all GStreamer pipelines.
        # This triggers on-negotiation-needed, but our sender gates offers
        # on _has_receiver, so they're deferred until a browser connects.
        for stream_id, builder in self.pipeline_builders.items():
            builder.start()
            logger.info(f"Pipeline started for stream: {stream_id}")

        # Step 4: Create data channels AFTER pipelines are PLAYING.
        # webrtcbin asserts 'is_closed != TRUE' if called in NULL state.
        self.webrtc_sender.create_data_channels()

        # Step 4: Start ROS2 bridge (feeds frames into pipelines)
        self.ros2_bridge.start()

        # Step 5: Keep alive + periodic clock info
        while self.webrtc_sender._connected:
            await asyncio.sleep(1)
            for stream_id in list(self.webrtc_sender.data_channels.keys()):
                self.webrtc_sender.send_clock_info(stream_id)

    def run(self):
        """Main run method."""
        self.setup()

        # Start GLib main loop in a thread (required for GStreamer)
        glib_thread = threading.Thread(target=self.glib_loop.run, daemon=True)
        glib_thread.start()

        # Run async event loop
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        try:
            loop.run_until_complete(self.run_async())
        except KeyboardInterrupt:
            logger.info("Shutting down...")
        finally:
            self.shutdown()

    def shutdown(self):
        """Clean shutdown."""
        self._running = False

        for stream_id, pipeline in self.pipelines.items():
            pipeline.set_state(Gst.State.NULL)
            logger.info(f"Pipeline stopped: {stream_id}")

        self.ros2_bridge.shutdown()
        self.glib_loop.quit()
        logger.info("Shutdown complete")


def main():
    parser = argparse.ArgumentParser(
        description='WebRTC GStreamer Video Sender for ROS2',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s --codec h264 --topics /camera/front /camera/rear
  %(prog)s --codec vp9 --topics /cam1 --width 1280 --height 720
  %(prog)s --codec vp8 --topics /cam1 /cam2 /cam3 --simulate
        """
    )

    parser.add_argument(
        '--codec', '-c', type=str, required=True,
        choices=list(CODEC_CONFIG.keys()),
        help='Video codec to use for encoding'
    )
    parser.add_argument(
        '--topics', '-t', type=str, nargs='+',
        default=['/camera/front'],
        help='ROS2 image topics to subscribe to'
    )
    parser.add_argument(
        '--signaling', '-s', type=str,
        default='ws://localhost:8080',
        help='WebSocket signaling server URL'
    )
    parser.add_argument(
        '--width', '-W', type=int, default=640,
        help='Frame width'
    )
    parser.add_argument(
        '--height', '-H', type=int, default=480,
        help='Frame height'
    )
    parser.add_argument(
        '--fps', '-f', type=int, default=30,
        help='Frames per second'
    )
    parser.add_argument(
        '--simulate', action='store_true',
        help='Use simulated camera feeds (no ROS2 required)'
    )
    parser.add_argument(
        '--verbose', '-v', action='store_true',
        help='Enable verbose logging'
    )

    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # Handle graceful shutdown
    signal.signal(signal.SIGINT, lambda s, f: sys.exit(0))
    signal.signal(signal.SIGTERM, lambda s, f: sys.exit(0))

    app = VideoSenderApp(args)
    app.run()


if __name__ == '__main__':
    main()