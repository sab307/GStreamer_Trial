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
        this.onConnectionStateChange = null; // (state) => {}
        this.onSenderJoined = null;        // (senderId, streams) => {}
        this.onSenderLeft = null;          // (senderId) => {}

        // State
        this._connected = false;
        this._receiverId = `browser_${Date.now().toString(36)}`;

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

            // Create answer
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            // Send answer back via signaling
            this._send({
                type: 'answer',
                stream_id: streamId,
                sender_id: senderId,
                sdp: answer.sdp,
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

            dc.onmessage = (msgEvent) => {
                try {
                    const data = JSON.parse(msgEvent.data);

                    if (data.type === 'frame_ts') {
                        if (this.onTimestampMessage) {
                            this.onTimestampMessage(streamId, data);
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