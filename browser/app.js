/**
 * App - Main orchestrator for the WebRTC Teleoperation Dashboard.
 *
 * Wires together:
 * - WebRTCManager (signaling + peer connections)
 * - ClockSync (NTP-style time synchronization)
 * - LatencyTracker (per-stream graphs with threshold alerts)
 * - DOM updates for the dashboard UI
 */
(function () {
    'use strict';

    // ---- Configuration ----
    const DEFAULT_SIGNALING = `ws://${window.location.hostname || 'localhost'}:8080`;
    const CLOCK_SYNC_INTERVAL = 2000;  // ms
    const CHART_RENDER_INTERVAL = 100; // ms (10 Hz)
    const UI_UPDATE_INTERVAL = 500;    // ms

    // ---- State ----
    const state = {
        signalingUrl: DEFAULT_SIGNALING,
        threshold: 100,
        connected: false,
    };

    // ---- Instances ----
    let webrtc = null;
    let clockSync = null;
    const latencyTrackers = new Map();  // stream_id -> LatencyTracker
    const streamCards = new Map();      // stream_id -> DOM element

    // ---- DOM References ----
    const dom = {
        connectBtn: document.getElementById('connectBtn'),
        connectionStatus: document.getElementById('connectionStatus'),
        clockOffset: document.getElementById('clockOffset'),
        clockRTT: document.getElementById('clockRTT'),
        thresholdInput: document.getElementById('latencyThreshold'),
        streamsContainer: document.getElementById('streamsContainer'),
        emptyState: document.getElementById('emptyState'),
        streamTemplate: document.getElementById('streamTemplate'),
        streamCount: document.getElementById('streamCount'),
        syncQuality: document.getElementById('syncQuality'),
        avgLatency: document.getElementById('avgLatency'),
        serverAddr: document.getElementById('serverAddr'),
    };

    // ---- Intervals ----
    let clockSyncInterval = null;
    let chartRenderInterval = null;
    let uiUpdateInterval = null;
    // REMOVED: decodeStatsInterval — no longer needed since we get decode
    // timing from requestVideoFrameCallback metadata.processingDuration

    // ============================================================
    //  Initialization
    // ============================================================

    function init() {
        // Set up event listeners
        dom.connectBtn.addEventListener('click', toggleConnection);
        dom.thresholdInput.addEventListener('change', onThresholdChange);
        dom.thresholdInput.addEventListener('input', onThresholdChange);

        // Listen for latency alert events (bubbles up from chart canvas)
        document.addEventListener('latency-alert', onLatencyAlert);

        // Set server address display
        dom.serverAddr.textContent = window.location.host || 'localhost:8080';

        // Initialize clock sync
        clockSync = new ClockSync();
        clockSync.onUpdate = onClockSyncUpdate;

        console.log('[App] Dashboard initialized');
    }

    // ============================================================
    //  Connection Management
    // ============================================================

    function toggleConnection() {
        if (state.connected) {
            disconnect();
        } else {
            connect();
        }
    }

    function connect() {
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        state.signalingUrl = `${wsProtocol}//${window.location.host}`;

        webrtc = new WebRTCManager(state.signalingUrl);

        // Wire up callbacks
        webrtc.onConnectionStateChange = onConnectionStateChange;
        webrtc.onStreamAdded = onStreamAdded;
        webrtc.onStreamRemoved = onStreamRemoved;
        webrtc.onTimestampMessage = onTimestampMessage;
        webrtc.onClockSyncMessage = (msg) => clockSync.handlePongMessage(msg);
        webrtc.onSenderJoined = onSenderJoined;
        webrtc.onSenderLeft = onSenderLeft;

        webrtc.connect();
    }

    function disconnect() {
        if (webrtc) {
            webrtc.disconnect();
            webrtc = null;
        }
        stopIntervals();
        clearAllStreams();
        state.connected = false;
        updateConnectionUI('disconnected');
    }

    function onConnectionStateChange(connState) {
        state.connected = connState === 'connected';
        updateConnectionUI(connState);

        if (state.connected) {
            startIntervals();
        } else {
            stopIntervals();
        }
    }

    function startIntervals() {
        // Clock sync ping/pong
        clockSyncInterval = setInterval(() => {
            if (webrtc && state.connected) {
                const msg = clockSync.createPingMessage();
                webrtc.sendClockSync(msg);
            }
        }, CLOCK_SYNC_INTERVAL);

        // Chart rendering (batched for performance)
        chartRenderInterval = setInterval(() => {
            for (const tracker of latencyTrackers.values()) {
                tracker.render();
            }
        }, CHART_RENDER_INTERVAL);

        // UI stats update
        uiUpdateInterval = setInterval(updateFooterStats, UI_UPDATE_INTERVAL);

        // REMOVED: decodeStatsInterval polling — decode time now comes from
        // requestVideoFrameCallback metadata.processingDuration (per-frame,
        // more accurate, and doesn't require polling RTCPeerConnection stats)
    }

    function stopIntervals() {
        if (clockSyncInterval) clearInterval(clockSyncInterval);
        if (chartRenderInterval) clearInterval(chartRenderInterval);
        if (uiUpdateInterval) clearInterval(uiUpdateInterval);
        clockSyncInterval = null;
        chartRenderInterval = null;
        uiUpdateInterval = null;
    }

    // REMOVED: pollDecodeStats() function entirely.
    // Previously this polled RTCPeerConnection.getStats() every second for
    // totalDecodeTime/framesDecoded. This has been replaced by
    // metadata.processingDuration inside requestVideoFrameCallback, which:
    //   1. Gives per-frame decode time (not averaged over 1s)
    //   2. Is matched to the exact frame being displayed
    //   3. Eliminates an async polling loop

    // ============================================================
    //  Stream Management
    // ============================================================

    function onSenderJoined(senderId, streams) {
        console.log(`[App] Sender joined: ${senderId} with streams: ${streams}`);
    }

    function onSenderLeft(senderId) {
        console.log(`[App] Sender left: ${senderId}`);
    }

    function onStreamAdded(streamId, mediaStream) {
        console.log(`[App] Stream added: ${streamId}`);

        // Create stream card if it doesn't exist
        if (!streamCards.has(streamId)) {
            createStreamCard(streamId);
        }

        // Attach media stream to video element
        const card = streamCards.get(streamId);
        const video = card.querySelector('video');

        // Only update if stream actually changed (avoid interrupting play)
        if (video.srcObject !== mediaStream) {
            video.srcObject = mediaStream;
            video.muted = true;      // required for autoplay
            video.playsInline = true; // required for mobile
            video.autoplay = true;

            // ── CHANGED: requestVideoFrameCallback now passes metadata ──
            // Previously we called tracker.onFrameDisplayed() with no args.
            // Now we extract timing from the metadata parameter:
            //   - metadata.receiveTime: when encoded frame arrived at decoder
            //   - metadata.expectedDisplayTime: when browser will show the frame
            //   - metadata.processingDuration: actual decode time for THIS frame
            // This replaces both the old onFrameDisplayed() heuristic AND
            // the pollDecodeStats() RTCPeerConnection stats polling.
            const tracker = latencyTrackers.get(streamId);
            if (tracker && 'requestVideoFrameCallback' in video) {
                const onVideoFrame = (now, metadata) => {
                    let browserLatency = null;
                    let processingDuration = null;

                    if (metadata.receiveTime && metadata.expectedDisplayTime) {
                        // True browser-side latency: arrival at decoder → display
                        browserLatency = metadata.expectedDisplayTime - metadata.receiveTime;
                    }
                    if (metadata.processingDuration) {
                        // Actual decode time for this specific frame (seconds → ms)
                        processingDuration = metadata.processingDuration * 1000;
                    }

                    tracker.onFrameDisplayed(browserLatency, processingDuration);

                    // Re-register for next frame
                    video.requestVideoFrameCallback(onVideoFrame);
                };
                video.requestVideoFrameCallback(onVideoFrame);
            }
            // ── END CHANGE ──

            // Try to play, with retry on failure
            const tryPlay = () => {
                video.play().catch(e => {
                    console.warn(`[App] Play failed for ${streamId}: ${e.message}`);
                    setTimeout(tryPlay, 500);
                });
            };
            tryPlay();
        }

        // Update empty state
        updateEmptyState();
    }

    function onStreamRemoved(streamId) {
        console.log(`[App] Stream removed: ${streamId}`);
        removeStreamCard(streamId);
        updateEmptyState();
    }

    function createStreamCard(streamId) {
        const template = dom.streamTemplate.content.cloneNode(true);
        const card = template.querySelector('.stream-card');

        card.dataset.streamId = streamId;
        card.querySelector('.stream-name').textContent = streamId.replace(/_/g, '/');

        // Create latency tracker for this stream's chart canvas
        const canvas = card.querySelector('.latency-chart');
        dom.streamsContainer.appendChild(card);

        // Must be in DOM before creating Chart.js instance
        const tracker = new LatencyTracker(streamId, canvas, {
            threshold: state.threshold,
            maxPoints: 120,
        });
        latencyTrackers.set(streamId, tracker);
        streamCards.set(streamId, card);
    }

    function removeStreamCard(streamId) {
        const card = streamCards.get(streamId);
        if (card) {
            card.remove();
            streamCards.delete(streamId);
        }

        const tracker = latencyTrackers.get(streamId);
        if (tracker) {
            tracker.destroy();
            latencyTrackers.delete(streamId);
        }
    }

    function clearAllStreams() {
        for (const streamId of [...streamCards.keys()]) {
            removeStreamCard(streamId);
        }
        updateEmptyState();
    }

    // ============================================================
    //  Timestamp & Latency Handling
    // ============================================================

    function onTimestampMessage(streamId, data) {
        const tracker = latencyTrackers.get(streamId);
        if (!tracker) return;

        // Add sample using clock sync for accurate network time
        tracker.addSample(data, clockSync);

        // Update per-stream UI
        updateStreamCardStats(streamId, tracker);
    }

    function updateStreamCardStats(streamId, tracker) {
        const card = streamCards.get(streamId);
        if (!card) return;

        const stats = tracker.getStats();
        const c = stats.current;

        // Helper: safely set text content (element may not exist in older HTML)
        const setText = (sel, text) => {
            const el = card.querySelector(sel);
            if (el) el.textContent = text;
        };

        // Update breakdown values
        setText('.encode-val', `${c.encode.toFixed(1)} ms`);
        setText('.pkt-val', `${c.packetize.toFixed(1)} ms`);
        setText('.net-val', `${c.network.toFixed(1)} ms`);
        setText('.decode-val', `${c.decode.toFixed(1)} ms`);
        setText('.render-val', `${c.render.toFixed(1)} ms`);
        setText('.total-val', `${c.total.toFixed(1)} ms`);

        // Update badges
        setText('.badge-latency', `${c.total.toFixed(0)} ms`);

        // Update FPS
        setText('.fps-counter', `${stats.fps} fps`);
    }

    // ============================================================
    //  Alert Handling
    // ============================================================

    function onLatencyAlert(event) {
        const { streamId, isAlert, latency, threshold } = event.detail;
        const card = streamCards.get(streamId);
        if (!card) return;

        if (isAlert) {
            card.classList.add('alert');
            card.querySelector('.badge-latency').classList.add('alert');
            card.querySelector('.latency-chart-container').classList.add('alert');
        } else {
            card.classList.remove('alert');
            card.querySelector('.badge-latency').classList.remove('alert');
            card.querySelector('.latency-chart-container').classList.remove('alert');
        }
    }

    function onThresholdChange() {
        const val = parseInt(dom.thresholdInput.value, 10);
        if (isNaN(val) || val < 1) return;

        state.threshold = val;

        // Update all trackers
        for (const tracker of latencyTrackers.values()) {
            tracker.setThreshold(val);
        }
    }

    // ============================================================
    //  Clock Sync UI
    // ============================================================

    function onClockSyncUpdate(offset, rtt, quality) {
        dom.clockOffset.textContent = offset.toFixed(1);
        dom.clockRTT.textContent = rtt.toFixed(1);
    }

    // ============================================================
    //  UI Updates
    // ============================================================

    function updateConnectionUI(connState) {
        const statusEl = dom.connectionStatus;
        const statusText = statusEl.querySelector('.status-text');
        const btn = dom.connectBtn;

        if (connState === 'connected') {
            statusEl.classList.add('connected');
            statusText.textContent = 'Connected';
            btn.textContent = 'Disconnect';
            btn.classList.add('active');
        } else {
            statusEl.classList.remove('connected');
            statusText.textContent = connState === 'error' ? 'Error' : 'Disconnected';
            btn.textContent = 'Connect';
            btn.classList.remove('active');
        }
    }

    function updateEmptyState() {
        const hasStreams = streamCards.size > 0;
        dom.emptyState.classList.toggle('hidden', hasStreams);
    }

    function updateFooterStats() {
        dom.streamCount.textContent = streamCards.size;

        // Sync quality
        const syncStats = clockSync.getStats();
        dom.syncQuality.textContent = syncStats.quality;

        // Average latency across all streams
        let totalLatency = 0;
        let count = 0;
        for (const tracker of latencyTrackers.values()) {
            const stats = tracker.getStats();
            if (stats.avg > 0) {
                totalLatency += stats.avg;
                count++;
            }
        }
        const avgLat = count > 0 ? totalLatency / count : 0;
        dom.avgLatency.textContent = avgLat > 0 ? `${avgLat.toFixed(1)} ms` : '--';
    }

    // ============================================================
    //  Boot
    // ============================================================

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();