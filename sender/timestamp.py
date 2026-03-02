"""
Timestamp tracker for detailed latency breakdown across the pipeline.

Tracks per-frame timestamps at each stage:
  1. capture_ts    - When the frame was captured from ROS2 / camera
  2. encode_ts     - When encoding started
  3. encoded_ts    - When encoding completed
  4. packetize_ts  - When RTP packetization completed
  5. send_ts       - When the frame was handed to WebRTC transport

From these we derive:
  - encode_time      = encoded_ts - encode_ts
  - packetize_time   = packetize_ts - encoded_ts
  - send_overhead    = send_ts - packetize_ts
  - sender_pipeline  = send_ts - capture_ts

The receiver (browser) adds:
  - network_time     = receive_ts - send_ts (after clock sync)
  - decode_time      = decoded_ts - receive_ts
  - total_latency    = decoded_ts - capture_ts (glass-to-glass)
"""

import time
import json
import logging
from dataclasses import dataclass, field, asdict
from collections import OrderedDict
from typing import Optional

logger = logging.getLogger(__name__)

# Maximum frames to track simultaneously (prevents memory leak)
MAX_TRACKED_FRAMES = 300


@dataclass
class FrameTimestamps:
    """Timestamps for a single frame through the pipeline."""
    frame_id: int
    stream_id: str
    capture_ts: float = 0.0      # monotonic ms
    encode_ts: float = 0.0       # monotonic ms - encode start
    encoded_ts: float = 0.0      # monotonic ms - encode complete
    packetize_ts: float = 0.0    # monotonic ms - packetization complete
    send_ts: float = 0.0         # monotonic ms - sent to transport
    wall_send_ts: float = 0.0    # wall clock ms - for cross-machine sync

    @property
    def encode_time(self) -> float:
        """Time spent encoding (ms)."""
        if self.encoded_ts and self.encode_ts:
            return self.encoded_ts - self.encode_ts
        return 0.0

    @property
    def packetize_time(self) -> float:
        """Time spent packetizing (ms)."""
        if self.packetize_ts and self.encoded_ts:
            return self.packetize_ts - self.encoded_ts
        return 0.0

    @property
    def sender_pipeline_time(self) -> float:
        """Total time in sender pipeline (ms)."""
        if self.send_ts and self.capture_ts:
            return self.send_ts - self.capture_ts
        return 0.0

    def to_datachannel_msg(self) -> str:
        """Serialize to compact JSON for data channel transmission."""
        return json.dumps({
            "type": "frame_ts",
            "fid": self.frame_id,
            "sid": self.stream_id,
            "cap": round(self.capture_ts, 3),
            "enc": round(self.encode_time, 3),
            "pkt": round(self.packetize_time, 3),
            "spl": round(self.sender_pipeline_time, 3),
            "wst": round(self.wall_send_ts, 3),  # wall clock for cross-machine
            "t": round(time.time() * 1000, 3),    # current wall time
        })


class TimestampTracker:
    """Tracks timestamps for multiple concurrent frames across streams."""

    def __init__(self):
        # stream_id -> OrderedDict[frame_id -> FrameTimestamps]
        self._frames: dict = {}
        self._frame_counters: dict = {}

    def _get_stream(self, stream_id: str) -> OrderedDict:
        if stream_id not in self._frames:
            self._frames[stream_id] = OrderedDict()
            self._frame_counters[stream_id] = 0
        return self._frames[stream_id]

    def _evict_old(self, stream: OrderedDict):
        """Evict old frames to prevent memory growth."""
        while len(stream) > MAX_TRACKED_FRAMES:
            stream.popitem(last=False)

    def _now_ms(self) -> float:
        """Current monotonic time in milliseconds."""
        return time.monotonic_ns() / 1_000_000

    def _wall_ms(self) -> float:
        """Current wall clock time in milliseconds."""
        return time.time() * 1000

    def on_capture(self, stream_id: str, capture_ns: int) -> int:
        """Record frame capture. Returns frame_id."""
        stream = self._get_stream(stream_id)
        self._frame_counters[stream_id] += 1
        fid = self._frame_counters[stream_id]

        stream[fid] = FrameTimestamps(
            frame_id=fid,
            stream_id=stream_id,
            capture_ts=capture_ns / 1_000_000,  # ns -> ms
        )
        self._evict_old(stream)
        return fid

    def on_encode_start(self, stream_id: str, frame_id: int):
        """Record encoding start."""
        stream = self._get_stream(stream_id)
        if frame_id in stream:
            stream[frame_id].encode_ts = self._now_ms()

    def on_encode_complete(self, stream_id: str, frame_id: int):
        """Record encoding complete."""
        stream = self._get_stream(stream_id)
        if frame_id in stream:
            stream[frame_id].encoded_ts = self._now_ms()

    def on_packetize(self, stream_id: str, frame_id: int):
        """Record packetization complete."""
        stream = self._get_stream(stream_id)
        if frame_id in stream:
            stream[frame_id].packetize_ts = self._now_ms()

    def on_send(self, stream_id: str, frame_id: int):
        """Record frame sent to transport."""
        stream = self._get_stream(stream_id)
        if frame_id in stream:
            stream[frame_id].send_ts = self._now_ms()
            stream[frame_id].wall_send_ts = self._wall_ms()

    def get_frame(self, stream_id: str, frame_id: int) -> Optional[FrameTimestamps]:
        """Get frame timestamps."""
        stream = self._get_stream(stream_id)
        return stream.get(frame_id)

    def get_latest(self, stream_id: str) -> Optional[FrameTimestamps]:
        """Get the most recent frame for a stream."""
        stream = self._get_stream(stream_id)
        if stream:
            fid = next(reversed(stream))
            return stream[fid]
        return None

    def get_stats(self, stream_id: str, last_n: int = 30) -> dict:
        """Get average stats over last N frames."""
        stream = self._get_stream(stream_id)
        frames = list(stream.values())[-last_n:]

        if not frames:
            return {"encode_avg": 0, "packetize_avg": 0, "pipeline_avg": 0}

        encode_times = [f.encode_time for f in frames if f.encode_time > 0]
        pkt_times = [f.packetize_time for f in frames if f.packetize_time > 0]
        pipe_times = [f.sender_pipeline_time for f in frames if f.sender_pipeline_time > 0]

        return {
            "encode_avg": sum(encode_times) / len(encode_times) if encode_times else 0,
            "packetize_avg": sum(pkt_times) / len(pkt_times) if pkt_times else 0,
            "pipeline_avg": sum(pipe_times) / len(pipe_times) if pipe_times else 0,
            "frame_count": len(frames),
        }