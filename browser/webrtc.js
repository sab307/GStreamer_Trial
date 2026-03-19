/**
 * WebRTCManager - Manages WebRTC peer connections for receiving
 * multiple video streams from the GStreamer sender.
 *
 * Handles:
 * - SDP offer/answer negotiation via WebSocket signaling
 * - ICE candidate exchange
 * - Data channel reception for timestamps
 * - Multiple simultaneous peer connections (one per stream)
 */
class WebRTCManager {
    constructor(signalingUrl) {
        this.signalingUrl = signalingUrl;
        this.ws = null;
        this.peerConnections = new Map();  // stream_id -> RTCPeerConnection
        this.dataChannels = new Map();     // stream_id -> RTCDataChannel
        this.remoteStreams = new Map();     // stream_id -> MediaStream

        // Callbacks
        this.onStreamAdded = null;         // (streamId, mediaStream) => {}
        this.onStreamRemoved = null;       // (streamId) => {}
        this.onTimestampMessage = null;    // (streamId, data) => {}
        this.onClockSyncMessage = null;    // (data) => {}
        this.onDCClockSyncMessage = null;  // (pongData) => {} — from sender via DataChannel
        this.onDCChannelOpen = null;       // (streamId) => {}
        this.onConnectionStateChange = null; // (state) => {}
        this.onSenderJoined = null;        // (senderId, streams) => {}
        this.onSenderLeft = null;          // (senderId) => {}

        // State
        this._connected = false;
        this._receiverId = `browser_${Date.now().toString(36)}`;

        // Clock provider for dc_ack timestamps.
        // Default: raw browser wall clock.  App wires this to clockSync.now()
        // once ClockSync has been calibrated against the Python sender, so
        // dc_ack receive_time is in the same epoch as wst (Python time.time()*1000).
        // OWD = receive_time - wst then needs no further correction on the sender.
        this.clockSyncNow = () => performance.now() + performance.timeOrigin;

        // ICE servers
        this.iceServers = [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
        ];
    }

    /**
     * Connect to the signaling server.
     */
    connect() {
        // Close existing connection first to prevent duplicates
        if (this.ws) {
            try { this.ws.close(); } catch(e) {}
            this.ws = null;
        }

        // Clean up any existing peer connections
        for (const [streamId, pc] of this.peerConnections) {
            pc.close();
        }
        this.peerConnections.clear();
        this.dataChannels.clear();
        this.remoteStreams.clear();

        const url = `${this.signalingUrl}/ws?role=receiver&id=${this._receiverId}`;
        console.log(`[WebRTC] Connecting to signaling: ${url}`);

        const ws = new WebSocket(url);
        this.ws = ws;

        ws.onopen = () => {
            if (this.ws !== ws) return;  // stale connection
            console.log('[WebRTC] Signaling connected');
            this._connected = true;
            this._notifyState('connected');
        };

        ws.onclose = (event) => {
            if (this.ws !== ws) {
                console.log(`[WebRTC] Stale WS closed (code ${event.code}), ignoring`);
                return;
            }

            console.log(`[WebRTC] Signaling closed: ${event.code} ${event.reason}`);
            this._connected = false;
            this._notifyState('disconnected');

            // Only auto-reconnect on abnormal closure
            if (event.code !== 1000 && event.code !== 1005) {
                setTimeout(() => {
                    if (this.ws === ws && !this._connected) {
                        console.log('[WebRTC] Attempting reconnect...');
                        this.connect();
                    }
                }, 3000);
            }
        };

        ws.onerror = (err) => {
            if (this.ws !== ws) return;
            console.error('[WebRTC] Signaling error:', err);
            this._notifyState('error');
        };

        ws.onmessage = (event) => {
            if (this.ws !== ws) return;
            this._handleSignalingMessage(JSON.parse(event.data));
        };
    }

    /**
     * Disconnect from signaling server.
     */
    disconnect() {
        const ws = this.ws;
        this.ws = null;  // set to null BEFORE close so onclose handler ignores it
        this._connected = false;

        if (ws) {
            try { ws.close(1000, 'user disconnect'); } catch(e) {}
        }

        // Close all peer connections
        for (const [streamId, pc] of this.peerConnections) {
            pc.close();
        }
        this.peerConnections.clear();
        this.dataChannels.clear();
        this.remoteStreams.clear();
        this._notifyState('disconnected');
    }

    /**
     * Send a message via the signaling WebSocket.
     */
    _send(msg) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }

    /**
     * Handle incoming signaling messages.
     */
    _handleSignalingMessage(msg) {
        switch (msg.type) {
            case 'offer':
                this._handleOffer(msg);
                break;
            case 'ice_candidate':
                this._handleIceCandidate(msg);
                break;
            case 'sender_joined':
                console.log(`[WebRTC] Sender joined: ${msg.sender_id}, streams: ${msg.streams}`);
                if (this.onSenderJoined) {
                    this.onSenderJoined(msg.sender_id, msg.streams || []);
                }
                break;
            case 'sender_left':
                console.log(`[WebRTC] Sender left: ${msg.sender_id}`);
                if (this.onSenderLeft) {
                    this.onSenderLeft(msg.sender_id);
                }
                break;
            case 'clock_sync_browser_response':
                if (this.onClockSyncMessage) {
                    this.onClockSyncMessage(msg);
                }
                break;
            default:
                console.debug(`[WebRTC] Unknown message type: ${msg.type}`);
        }
    }

    /**
     * Handle SDP offer from sender.
     */
    async _handleOffer(msg) {
        const streamId = msg.stream_id;
        const senderId = msg.sender_id;
        const sdp = msg.sdp;

        console.log(`[WebRTC] Received offer for stream: ${streamId}`);

        // Create or get peer connection for this stream
        let pc = this.peerConnections.get(streamId);
        if (pc) {
            // Close existing connection
            pc.close();
        }

        pc = this._createPeerConnection(streamId, senderId);
        this.peerConnections.set(streamId, pc);

        try {
            // Set remote description (offer)
            await pc.setRemoteDescription(new RTCSessionDescription({
                type: 'offer',
                sdp: sdp,
            }));

            // Create answer, preferring H.264 Baseline (no B-frames, lower decode latency)
            const answer = await pc.createAnswer();
            const preferredSdp = this._preferH264Baseline(answer.sdp);
            const finalAnswer = new RTCSessionDescription({ type: 'answer', sdp: preferredSdp });
            await pc.setLocalDescription(finalAnswer);

            // Send answer back via signaling
            this._send({
                type: 'answer',
                stream_id: streamId,
                sender_id: senderId,
                sdp: preferredSdp,
            });

            console.log(`[WebRTC] Sent answer for stream: ${streamId}`);

        } catch (err) {
            console.error(`[WebRTC] Error handling offer for ${streamId}:`, err);
        }
    }

    /**
     * Handle ICE candidate from sender.
     */
    async _handleIceCandidate(msg) {
        const streamId = msg.stream_id;
        const pc = this.peerConnections.get(streamId);

        if (!pc) {
            console.warn(`[WebRTC] No peer connection for ICE candidate: ${streamId}`);
            return;
        }

        try {
            await pc.addIceCandidate(new RTCIceCandidate({
                candidate: msg.candidate,
                sdpMLineIndex: msg.sdpMLineIndex,
            }));
        } catch (err) {
            console.error(`[WebRTC] ICE candidate error for ${streamId}:`, err);
        }
    }

    /**
     * Create a new RTCPeerConnection for a stream.
     */
    _createPeerConnection(streamId, senderId) {
        const config = {
            iceServers: this.iceServers,
            bundlePolicy: 'max-bundle',
        };

        const pc = new RTCPeerConnection(config);

        // ICE candidate handler
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this._send({
                    type: 'ice_candidate',
                    stream_id: streamId,
                    sender_id: senderId,
                    candidate: event.candidate.candidate,
                    sdpMLineIndex: event.candidate.sdpMLineIndex,
                });
            }
        };

        // ICE connection state
        pc.oniceconnectionstatechange = () => {
            console.log(`[WebRTC] ICE state for ${streamId}: ${pc.iceConnectionState}`);
            if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
                console.warn(`[WebRTC] Stream ${streamId} ICE ${pc.iceConnectionState}`);
            }
        };

        // ── CHANGED: Track handler — added playoutDelayHint = 0 ──
        // For teleoperation, we want minimum jitter buffering. The browser's
        // default jitter buffer adds 50-150ms of delay for smooth playout,
        // which is unacceptable for real-time robot control.
        // playoutDelayHint = 0 tells the browser we prefer minimum latency
        // even if it means occasional frame drops or jitter.
        pc.ontrack = (event) => {
            console.log(`[WebRTC] Track received for ${streamId}: ${event.track.kind}`);

            // Minimize jitter buffer for low-latency teleoperation
            const receiver = event.receiver;
            if (receiver && 'playoutDelayHint' in receiver) {
                receiver.playoutDelayHint = 0;
                console.log(`[WebRTC] Set playoutDelayHint=0 for ${streamId}`);
            }

            const stream = event.streams[0] || new MediaStream([event.track]);
            this.remoteStreams.set(streamId, stream);

            if (this.onStreamAdded) {
                this.onStreamAdded(streamId, stream);
            }
        };
        // ── END CHANGE ──

        // Data channel handler
        pc.ondatachannel = (event) => {
            const dc = event.channel;
            console.log(`[WebRTC] Data channel received: ${dc.label}`);

            this.dataChannels.set(streamId, dc);

            dc.onopen = () => {
                console.log(`[WebRTC] Data channel open: ${streamId}`);
                if (this.onDCChannelOpen) {
                    this.onDCChannelOpen(streamId);
                }
            };

            dc.onmessage = (msgEvent) => {
                try {
                    const data = JSON.parse(msgEvent.data);

                    if (data.type === 'frame_ts') {
                        // ── SCReAM feedback: echo fid + receive time back to sender ──
                        // receive_time uses clockSyncNow() which equals Python time.time()*1000
                        // once DC clock sync is active.  On the sender:
                        //   OWD = ack.receive_time - frame_ts.wst   (same clock, no correction)
                        // We rate-limit ACKs: every frame is ACK'd but the sender only acts
                        // on them every 200ms (UPDATE_INTERVAL_S), so DataChannel bandwidth
                        // overhead is ~30 frames/s × ~50 bytes = ~1.5 kbps — negligible.
                        if (dc.readyState === 'open') {
                            dc.send(JSON.stringify({
                                type: 'dc_ack',
                                fid:          data.fid,
                                receive_time: this.clockSyncNow(),
                            }));
                        }

                        if (this.onTimestampMessage) {
                            this.onTimestampMessage(streamId, data);
                        }
                    } else if (data.type === 'dc_pong') {
                        // Clock sync pong from sender — t2/t3 stamped by Python time.time()
                        if (this.onDCClockSyncMessage) {
                            this.onDCClockSyncMessage(data);
                        }
                    } else if (data.type === 'clock_info') {
                        // Clock info from sender - can be used for additional sync
                    }
                } catch (e) {
                    // Binary or non-JSON message
                }
            };

            dc.onclose = () => {
                console.log(`[WebRTC] Data channel closed for ${streamId}`);
                this.dataChannels.delete(streamId);
            };
        };

        return pc;
    }

    /**
     * Send a clock sync request through the signaling WebSocket.
     */
    sendClockSync(message) {
        this._send(JSON.parse(message));
    }

    /**
     * Send a dc_ping clock sync through a data channel.
     * Uses the first open data channel found (any stream works — all go to same sender).
     * t2/t3 in the pong will be stamped by Python time.time(), the same clock used for wst.
     * @param {Object} pingMsg - {type:'dc_ping', t1:number}
     * @returns {boolean} true if a DC was found and the message was sent
     */
    sendDCClockSync(pingMsg) {
        for (const [, dc] of this.dataChannels) {
            if (dc.readyState === 'open') {
                dc.send(JSON.stringify(pingMsg));
                return true;
            }
        }
        return false;
    }

    /**
     * Reorder m=video payload types to prefer H.264 Baseline (profile-level-id 42xxxx).
     * Baseline has no B-frames and simpler entropy coding → lower decode latency.
     * Called on the answer SDP before setLocalDescription so the sender sees our preference.
     * @param {string} sdp - SDP string from createAnswer()
     * @returns {string} Modified SDP with Baseline H264 PTs first (unchanged if none found)
     */
    _preferH264Baseline(sdp) {
        const sep = sdp.includes('\r\n') ? '\r\n' : '\n';
        const lines = sdp.split(sep);

        // Step 1: collect H264 payload types from a=rtpmap lines
        const h264PTs = new Set();
        for (const line of lines) {
            const m = line.match(/^a=rtpmap:(\d+) H264\/90000/i);
            if (m) h264PTs.add(m[1]);
        }
        if (h264PTs.size === 0) return sdp;

        // Step 2: which of those H264 PTs have Baseline profile (first byte of profile-level-id = 42)?
        const baselinePTs = [];
        for (const pt of h264PTs) {
            for (const line of lines) {
                const fm = line.match(new RegExp(`^a=fmtp:${pt} .*profile-level-id=([0-9a-fA-F]{6})`, 'i'));
                if (fm && fm[1].toLowerCase().startsWith('42')) {
                    baselinePTs.push(pt);
                    break;
                }
            }
        }
        if (baselinePTs.length === 0) return sdp;

        // Step 3: reorder m=video PT list — Baseline PTs first
        return lines.map(line => {
            if (!line.startsWith('m=video')) return line;
            const parts = line.split(' ');
            const header = parts.slice(0, 3);   // 'm=video', port, protocol
            const allPTs = parts.slice(3);
            const reordered = [
                ...baselinePTs.filter(pt => allPTs.includes(pt)),
                ...allPTs.filter(pt => !baselinePTs.includes(pt)),
            ];
            console.log(`[WebRTC] H264 Baseline preferred PTs: [${baselinePTs}] of [${allPTs}]`);
            return [...header, ...reordered].join(' ');
        }).join(sep);
    }

    /**
     * Get connection info.
     */
    getInfo() {
        const streams = {};
        for (const [id, pc] of this.peerConnections) {
            streams[id] = {
                iceState: pc.iceConnectionState,
                signalingState: pc.signalingState,
                hasDataChannel: this.dataChannels.has(id),
            };
        }
        return {
            connected: this._connected,
            receiverId: this._receiverId,
            streamCount: this.peerConnections.size,
            streams: streams,
        };
    }

    _notifyState(state) {
        if (this.onConnectionStateChange) {
            this.onConnectionStateChange(state);
        }
    }
}

// Export
window.WebRTCManager = WebRTCManager;