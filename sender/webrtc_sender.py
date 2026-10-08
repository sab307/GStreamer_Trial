"""
WebRTC Sender: Manages peer connections, signaling via WebSocket,
and data channels for timestamp/clock sync transmission.

Uses GstWebRTC (webrtcbin) for WebRTC transport.
"""

import asyncio
import json
import time
import logging
import threading
import websockets
from typing import Dict, Optional, Callable

import gi
gi.require_version('Gst', '1.0')
gi.require_version('GstWebRTC', '1.0')
gi.require_version('GstSdp', '1.0')
from gi.repository import Gst, GstWebRTC, GstSdp, GLib

from timestamp import TimestampTracker, FrameTimestamps

logger = logging.getLogger(__name__)

# STUN servers for ICE candidate gathering.
# Without STUN, webrtcbin only generates host candidates with private IPs,
# which causes ICE to fail even on localhost in many configurations.
STUN_SERVER = "stun://stun.l.google.com:19302"


class WebRTCSender:
    """
    Manages WebRTC peer connections for multiple video streams.
    Handles signaling via WebSocket and timestamp data channels.
    """

    def __init__(self, signaling_url: str, sender_id: str = "ros2_sender"):
        self.signaling_url = signaling_url
        self.sender_id = sender_id
        self.ws: Optional[websockets.WebSocketClientProtocol] = None
        self.pipelines: Dict[str, Gst.Pipeline] = {}
        self.pipeline_builders = {}
        self.webrtcbins: Dict[tuple, Gst.Element] = {}
        self.data_channels: Dict[tuple, object] = {}
        self._dc_open: set = set()  # (receiver_id, stream_id) pairs
        self._peers = {}
        self.timestamp_tracker = TimestampTracker()
        self._connected = False
        self._clock_offset_ms = 0.0

        # Track whether a receiver is connected.
        # on-negotiation-needed fires when pipeline starts PLAYING, but if
        # no receiver is connected yet those offers are wasted and cause
        # duplicate-offer race conditions when receiver finally joins.
        self._offers_pending = set()  # (receiver_id, stream_id) pairs waiting for receiver

        # The asyncio event loop — set early so GStreamer thread callbacks
        # can schedule coroutines via run_coroutine_threadsafe().
        # MUST be set before any pipeline starts playing.
        self.loop: Optional[asyncio.AbstractEventLoop] = None

        # Queue for messages from GStreamer thread when loop isn't ready yet
        self._pending_msgs = []
        self._pending_lock = threading.Lock()

    def _send_signaling(self, msg_str: str):
        """
        Thread-safe: send a signaling message from any thread.
        If the async loop is available, schedule it. Otherwise queue it.
        """
        if self.loop and self._connected and self.ws:
            asyncio.run_coroutine_threadsafe(self._ws_send(msg_str), self.loop)
        else:
            with self._pending_lock:
                self._pending_msgs.append(msg_str)

    async def _ws_send(self, msg_str: str):
        """Actually send via websocket (must run in async context)."""
        try:
            if self._connected and self.ws:
                await self.ws.send(msg_str)
        except Exception as e:
            logger.warning(f"WebSocket send error: {e}")

    async def _flush_pending(self):
        """Send any messages queued before the loop was ready."""
        with self._pending_lock:
            msgs = list(self._pending_msgs)
            self._pending_msgs.clear()
        for msg in msgs:
            await self._ws_send(msg)
        if msgs:
            logger.info(f"Flushed {len(msgs)} pending signaling messages")

    async def connect_signaling(self):
        """Connect to the Go signaling server via WebSocket."""
        uri = f"{self.signaling_url}/ws?role=sender&id={self.sender_id}"
        logger.info(f"Connecting to signaling server: {uri}")

        try:
            self.ws = await websockets.connect(uri, ping_interval=5, ping_timeout=10)
            self._connected = True
            logger.info("Connected to signaling server")

            # Send registration with stream list
            await self.ws.send(json.dumps({
                "type": "register",
                "role": "sender",
                "id": self.sender_id,
                "streams": list(self.pipelines.keys()),
            }))

            # Flush any ICE candidates queued before connection was ready
            await self._flush_pending()

            # Start receiving messages
            asyncio.ensure_future(self._receive_loop())

            # Start clock sync
            asyncio.ensure_future(self._clock_sync_loop())

        except Exception as e:
            logger.error(f"Failed to connect to signaling: {e}")
            raise

    async def _receive_loop(self):
        """Receive and handle signaling messages."""
        try:
            async for raw_msg in self.ws:
                msg = json.loads(raw_msg)
                msg_type = msg.get("type", "")

                if msg_type == "answer":
                    await self._handle_answer(msg)
                elif msg_type == "ice_candidate":
                    self._handle_ice_candidate(msg)
                elif msg_type == "clock_sync_response":
                    self._handle_clock_sync_response(msg)
                elif msg_type == "receiver_joined":
                    receiver_id = msg.get('id', '')
                    logger.info(f"Receiver joined: {receiver_id}")
                    await self._add_receiver(receiver_id)
                elif msg_type == "receiver_left":
                    receiver_id = msg.get('id', '') if isinstance(msg.get('id'), str) else str(msg.get('id', ''))
                    logger.info(f"Receiver left: {receiver_id}")
                    self._remove_receiver(receiver_id)
                elif msg_type == "error":
                    logger.error(f"Signaling error: {msg.get('message')}")
                else:
                    logger.debug(f"Unknown message type: {msg_type}")

        except websockets.ConnectionClosed:
            logger.warning("Signaling connection closed")
            self._connected = False
        except Exception as e:
            logger.error(f"Receive loop error: {e}")

    async def _clock_sync_loop(self):
        """Periodically sync clock with signaling server (NTP-style)."""
        while self._connected:
            try:
                t1 = time.time() * 1000
                await self.ws.send(json.dumps({
                    "type": "clock_sync_request",
                    "t1": t1,
                    "sender_id": self.sender_id,
                }))
            except Exception as e:
                logger.warning(f"Clock sync send error: {e}")
            await asyncio.sleep(2)

    def _handle_clock_sync_response(self, msg: dict):
        """NTP-style clock offset: offset = ((t2-t1) + (t3-t4)) / 2."""
        t1 = msg.get("t1", 0)
        t2 = msg.get("t2", 0)
        t3 = msg.get("t3", 0)
        t4 = time.time() * 1000

        rtt = (t4 - t1) - (t3 - t2)
        offset = ((t2 - t1) + (t3 - t4)) / 2

        alpha = 0.3
        self._clock_offset_ms = alpha * offset + (1 - alpha) * self._clock_offset_ms
        logger.debug(f"Clock sync: RTT={rtt:.1f}ms, offset={self._clock_offset_ms:.1f}ms")

    def register_pipeline(self, stream_id: str, pipeline: Gst.Pipeline, builder):
        """Register a shared encoded pipeline for receiver branches."""
        self.pipelines[stream_id] = pipeline
        self.pipeline_builders[stream_id] = builder
        logger.info(f"Pipeline registered for stream: {stream_id} (data channel deferred)")

    async def _add_receiver(self, receiver_id: str):
        """Create independent WebRTC branches and negotiate with one receiver."""
        if not receiver_id or receiver_id in self._peers:
            return

        peer = {"webrtcbins": {}, "ice_state": {}, "data_channels": {}, "dc_open": set()}
        self._peers[receiver_id] = peer
        try:
            for stream_id, builder in self.pipeline_builders.items():
                webrtcbin = builder.add_receiver_branch(receiver_id)
                webrtcbin.set_property('stun-server', STUN_SERVER)
                webrtcbin.connect('on-negotiation-needed', self._on_negotiation_needed,
                                  receiver_id, stream_id)
                webrtcbin.connect('on-ice-candidate', self._on_ice_candidate,
                                  receiver_id, stream_id)
                webrtcbin.connect('notify::ice-connection-state', self._on_ice_state,
                                  receiver_id, stream_id)
                webrtcbin.connect('notify::ice-gathering-state', self._on_ice_gathering_state,
                                  receiver_id, stream_id)
                peer["webrtcbins"][stream_id] = webrtcbin
                self.webrtcbins[(receiver_id, stream_id)] = webrtcbin
                if builder.pipeline.current_state == Gst.State.PLAYING:
                    self._try_create_data_channel(receiver_id, stream_id, webrtcbin)
            await self._create_offers(receiver_id)
        except Exception:
            logger.exception(f"Failed to create receiver branches for {receiver_id}")
            self._remove_receiver(receiver_id)

    def _try_create_data_channel(self, receiver_id: str, stream_id: str, webrtcbin):
        """Create a data channel on webrtcbin (must be in PLAYING state)."""
        key = (receiver_id, stream_id)
        if key in self.data_channels:
            return  # already created
        try:
            dc = webrtcbin.emit('create-data-channel', f'timestamps_{stream_id}', None)
            if dc:
                dc.connect('on-open', self._on_data_channel_open, receiver_id, stream_id)
                dc.connect('on-close', self._on_data_channel_close, receiver_id, stream_id)
                self.data_channels[key] = dc
                logger.info(f"Data channel created for {receiver_id}/{stream_id}")
            else:
                logger.warning(f"create-data-channel returned None for {stream_id}")
        except Exception as e:
            logger.warning(f"Failed to create data channel for {stream_id}: {e}")

    def create_data_channels(self):
        """Create deferred channels after shared pipelines reach PLAYING."""
        for receiver_id, peer in self._peers.items():
            for stream_id, webrtcbin in peer["webrtcbins"].items():
                self._try_create_data_channel(receiver_id, stream_id, webrtcbin)

    def _on_ice_state(self, webrtcbin, pspec, receiver_id: str, stream_id: str):
        """Log ICE connection state changes from webrtcbin."""
        state = webrtcbin.get_property('ice-connection-state')
        state_names = {
            0: "new", 1: "checking", 2: "connected", 3: "completed",
            4: "failed", 5: "disconnected", 6: "closed",
        }
        name = state_names.get(state, f"unknown({state})")
        logger.info(f"[ICE] {stream_id}: connection state = {name}")

        # Track state
        if receiver_id in self._peers:
            self._peers[receiver_id]["ice_state"][stream_id] = name

    def _on_ice_gathering_state(self, webrtcbin, pspec, receiver_id: str, stream_id: str):
        """Log ICE gathering state changes."""
        state = webrtcbin.get_property('ice-gathering-state')
        state_names = {0: "new", 1: "gathering", 2: "complete"}
        name = state_names.get(state, f"unknown({state})")
        logger.info(f"[ICE] {stream_id}: gathering state = {name}")

    def _on_negotiation_needed(self, webrtcbin, receiver_id: str, stream_id: str):
        """Handle negotiation needed for one receiver branch."""
        if receiver_id not in self._peers:
            return
        logger.info(f"Negotiation needed for {receiver_id}/{stream_id}")
        promise = Gst.Promise.new_with_change_func(
            self._on_offer_created, webrtcbin, receiver_id, stream_id
        )
        webrtcbin.emit('create-offer', None, promise)

    def _on_offer_created(self, promise, webrtcbin, receiver_id: str, stream_id: str):
        """Handle created offer - set local description and send via signaling."""
        promise.wait()
        reply = promise.get_reply()
        offer = reply.get_value('offer')

        if offer is None:
            logger.error(f"Failed to create offer for {stream_id}")
            return

        webrtcbin.emit('set-local-description', offer, None)

        sdp_text = offer.sdp.as_text()
        candidate_count = sdp_text.count('a=candidate:')
        logger.info(f"Sending offer for {stream_id} ({candidate_count} candidates in SDP)")

        msg = json.dumps({
            "type": "offer",
            "stream_id": stream_id,
            "receiver_id": receiver_id,
            "sdp": sdp_text,
            "sender_id": self.sender_id,
        })

        self._send_signaling(msg)

    async def _create_offers(self, receiver_id: str):
        """Create offers for all streams for one receiver."""
        peer = self._peers.get(receiver_id)
        if not peer:
            return
        for stream_id, webrtcbin in peer["webrtcbins"].items():
            logger.info(f"Creating offer for stream: {stream_id}")
            promise = Gst.Promise.new_with_change_func(
                self._on_offer_created, webrtcbin, receiver_id, stream_id
            )
            webrtcbin.emit('create-offer', None, promise)

    async def _handle_answer(self, msg: dict):
        """Handle SDP answer from receiver."""
        receiver_id = msg.get("receiver_id", "")
        stream_id = msg.get("stream_id", "")
        sdp_text = msg.get("sdp", "")

        webrtcbin = self.webrtcbins.get((receiver_id, stream_id))
        if not webrtcbin:
            logger.error(f"Unknown receiver/stream in answer: {receiver_id}/{stream_id}")
            return

        logger.info(f"Received answer for stream: {stream_id}")

        res, sdpmsg = GstSdp.SDPMessage.new()
        GstSdp.sdp_message_parse_buffer(bytes(sdp_text, 'utf-8'), sdpmsg)
        answer = GstWebRTC.WebRTCSessionDescription.new(
            GstWebRTC.WebRTCSDPType.ANSWER, sdpmsg
        )
        webrtcbin.emit('set-remote-description', answer, None)

    def _on_ice_candidate(self, webrtcbin, mline_index, candidate,
                          receiver_id: str, stream_id: str):
        """
        Send ICE candidate to signaling server.
        Called from GStreamer thread — uses thread-safe _send_signaling.
        """
        logger.info(f"[ICE] {stream_id}: local candidate mline={mline_index}: {candidate[:60]}...")

        msg = json.dumps({
            "type": "ice_candidate",
            "receiver_id": receiver_id,
            "stream_id": stream_id,
            "candidate": candidate,
            "sdpMLineIndex": mline_index,
            "sender_id": self.sender_id,
        })
        self._send_signaling(msg)

    def _handle_ice_candidate(self, msg: dict):
        """Handle ICE candidate from receiver (browser)."""
        receiver_id = msg.get("receiver_id", "")
        stream_id = msg.get("stream_id", "")
        candidate = msg.get("candidate", "")
        sdp_mline_index = msg.get("sdpMLineIndex", 0)

        if not candidate:
            return

        webrtcbin = self.webrtcbins.get((receiver_id, stream_id))
        if webrtcbin:
            logger.info(f"[ICE] {stream_id}: remote candidate mline={sdp_mline_index}: {candidate[:60]}...")
            webrtcbin.emit(
                'add-ice-candidate', sdp_mline_index, candidate
            )
        else:
            logger.warning(f"[ICE] Unknown stream for remote candidate: {stream_id}")

    def _on_data_channel_open(self, dc, receiver_id: str, stream_id: str):
        """Data channel opened."""
        key = (receiver_id, stream_id)
        logger.info(f"Data channel opened: {receiver_id}/{stream_id}")
        self.data_channels[key] = dc
        self._dc_open.add(key)

    def _on_data_channel_close(self, dc, receiver_id: str, stream_id: str):
        """Data channel closed."""
        key = (receiver_id, stream_id)
        logger.info(f"Data channel closed: {receiver_id}/{stream_id}")
        self._dc_open.discard(key)
        self.data_channels.pop(key, None)

    def _remove_receiver(self, receiver_id: str):
        """Tear down one receiver without affecting any other peer."""
        peer = self._peers.pop(receiver_id, None)
        if not peer:
            return
        for stream_id in list(peer["webrtcbins"]):
            self.data_channels.pop((receiver_id, stream_id), None)
            self._dc_open.discard((receiver_id, stream_id))
            self.webrtcbins.pop((receiver_id, stream_id), None)
            builder = self.pipeline_builders.get(stream_id)
            if builder:
                builder.remove_receiver_branch(receiver_id)
        logger.info(f"Removed receiver {receiver_id}")

    def send_timestamp(self, receiver_id: str, stream_id: str, frame_ts: FrameTimestamps):
        """Send frame timestamps over data channel."""
        key = (receiver_id, stream_id)
        if key in self._dc_open:
            dc = self.data_channels[key]
            try:
                msg = frame_ts.to_datachannel_msg()
                dc.emit('send-string', msg)
            except Exception as e:
                logger.debug(f"Failed to send timestamp for {stream_id}: {e}")

    def send_clock_info(self, receiver_id: Optional[str] = None, stream_id: Optional[str] = None):
        """Send clock offset info over data channel."""
        targets = list(self._dc_open)
        if receiver_id is not None:
            targets = [key for key in targets if key[0] == receiver_id]
        if stream_id is not None:
            targets = [key for key in targets if key[1] == stream_id]
        for target_receiver, target_stream in targets:
            dc = self.data_channels.get((target_receiver, target_stream))
            if not dc:
                continue
            try:
                msg = json.dumps({
                    "type": "clock_info",
                    "sid": target_stream,
                    "offset": round(self._clock_offset_ms, 3),
                    "t": round(time.time() * 1000, 3),
                })
                dc.emit('send-string', msg)
            except Exception:
                pass

    async def run(self):
        """Main run loop. Safe to call even if already connected.

        If called from main.py (which sets loop and connects signaling
        before calling this), it just runs the keep-alive loop.
        If called standalone, it handles everything.
        """
        if not self.loop:
            self.loop = asyncio.get_event_loop()
            logger.info("Event loop set for GStreamer thread callbacks")

        if not self._connected:
            await self.connect_signaling()

        while self._connected:
            await asyncio.sleep(1)
            self.send_clock_info()