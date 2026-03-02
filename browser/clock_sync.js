/**
 * ClockSync - NTP-style clock synchronization with drift compensation.
 *
 * Maintains synchronized time between browser and signaling server
 * using periodic ping/pong exchanges. Uses exponential moving average
 * to smooth out offset estimates and detect drift.
 *
 */
class ClockSync {
    constructor() {
        // Current best estimates
        this.offset = 0;          // ms: server_time = local_time + offset
        this.rtt = 0;             // ms: round-trip time to server
        this.drift = 0;           // ms/s: estimated clock drift rate

        // History for drift estimation
        this.history = [];        // [{time, offset, rtt}]
        this.maxHistory = 60;     // keep last 60 samples

        // EMA smoothing
        this.alpha = 0.2;         // smoothing factor (lower = more stable)
        this.rttAlpha = 0.3;

        // State
        this.pendingPing = null;  // {t1, id}
        this.syncCount = 0;
        this.lastSyncTime = 0;
        this.quality = 'unknown'; // 'excellent', 'good', 'fair', 'poor', 'unknown'

        // ── Large-skew / two-stage calibration ──────────────────────────────
        // When the remote clock differs by more than LARGE_SKEW_THRESHOLD ms
        // (e.g. Python sender vs browser are ±10 s apart), the raw NTP offset
        // will be huge and must be accepted rather than rejected as an outlier.
        // After a few samples we lock in a stable "large-skew offset" and use
        // it to compensate latency calculations transparently.
        this.LARGE_SKEW_THRESHOLD = 2000;   // ms – above this we treat as large-skew
        this.largeSkewOffset = 0;           // stable calibrated skew (ms)
        this.largeSkewCalibrated = false;   // true once we have a stable estimate
        this.largeSkewSamples = [];         // raw offset samples during calibration
        this.MAX_SKEW_SAMPLES = 10;
        // ────────────────────────────────────────────────────────────────────

        // Callbacks
        this.onUpdate = null;     // (offset, rtt, quality) => {}
    }

    /**
     * Create a clock sync request message to send via WebSocket.
     * @returns {string} JSON message to send
     */
    createPingMessage() {
        const t1 = performance.now() + performance.timeOrigin; // wall clock ms
        this.pendingPing = {
            t1: t1,
            localT1: performance.now(),
            id: ++this.syncCount,
        };

        return JSON.stringify({
            type: 'clock_sync_browser',
            t1: t1,
        });
    }

    /**
     * Process a clock sync response from the server.
     * Implements NTP-style offset calculation:
     *   offset = ((t2 - t1) + (t3 - t4)) / 2
     *   rtt    = (t4 - t1) - (t3 - t2)
     *
     * Handles large clock skews (≥ LARGE_SKEW_THRESHOLD) via a two-stage
     * calibration path so a 10-second difference does not cause every
     * sample to be discarded as an outlier.
     *
     * @param {Object} msg - Response with t1, t2, t3 fields
     */
    handlePongMessage(msg) {
        if (!this.pendingPing) return;

        const t1 = msg.t1;                                          // browser send time
        const t2 = msg.t2;                                          // server receive time
        const t3 = msg.t3;                                          // server send time
        const t4 = performance.now() + performance.timeOrigin;      // browser receive time

        // NTP calculations
        const rtt = (t4 - t1) - (t3 - t2);
        const rawOffset = ((t2 - t1) + (t3 - t4)) / 2;

        // ── Large-skew detection ──────────────────────────────────────────────
        // If the raw offset is much larger than the RTT, the clocks differ by
        // more than network noise – treat as large-skew and calibrate separately.
        const isLargeSkew = Math.abs(rawOffset) > this.LARGE_SKEW_THRESHOLD;

        if (isLargeSkew) {
            this._handleLargeSkewSample(rawOffset, rtt);
            this.pendingPing = null;
            return;
        }

        // If we previously detected a large skew but now it disappeared, reset.
        if (this.largeSkewCalibrated && Math.abs(rawOffset) < this.LARGE_SKEW_THRESHOLD / 2) {
            console.warn('[ClockSync] Large skew resolved, resetting calibration.');
            this.largeSkewCalibrated = false;
            this.largeSkewOffset = 0;
            this.largeSkewSamples = [];
        }
        // ─────────────────────────────────────────────────────────────────────

        // Reject high-RTT outliers (only after skew check – avoids discarding
        // legitimate large-offset samples as outliers).
        const outlierThreshold = Math.max(this.rtt * 3, 50);
        if (this.rtt > 0 && rtt > outlierThreshold && this.syncCount > 5) {
            console.warn(`[ClockSync] Rejected outlier: RTT=${rtt.toFixed(1)}ms (threshold=${outlierThreshold.toFixed(1)}ms)`);
            this.pendingPing = null;
            return;
        }

        // Update EMA estimates
        if (this.syncCount <= 3) {
            // Use raw values for first few samples
            this.offset = rawOffset;
            this.rtt = rtt;
        } else {
            this.offset = this.alpha * rawOffset + (1 - this.alpha) * this.offset;
            this.rtt = this.rttAlpha * rtt + (1 - this.rttAlpha) * this.rtt;
        }

        // Track history for drift estimation
        const now = performance.now();
        this.history.push({
            time: now,
            offset: this.offset,
            rtt: this.rtt,
        });
        if (this.history.length > this.maxHistory) {
            this.history.shift();
        }

        // Estimate drift from offset trend
        this._estimateDrift();

        // Determine sync quality based on RTT stability
        this._updateQuality();

        this.lastSyncTime = now;
        this.pendingPing = null;

        // Notify listeners
        if (this.onUpdate) {
            this.onUpdate(this.offset, this.rtt, this.quality);
        }
    }

    /**
     * Accumulate large-skew samples and, once stable, lock in
     * largeSkewOffset so latency calculations remain correct even
     * when the remote clock is ±10 s from the browser clock.
     */
    _handleLargeSkewSample(rawOffset, rtt) {
        // Reject obviously bad RTTs
        if (rtt < 0 || rtt > 5000) return;

        this.largeSkewSamples.push({ offset: rawOffset, rtt });
        if (this.largeSkewSamples.length > this.MAX_SKEW_SAMPLES) {
            this.largeSkewSamples.shift();
        }

        if (this.largeSkewSamples.length >= 3) {
            // Use the best (lowest-RTT) half of samples – same as WebRTCClient
            const sorted = [...this.largeSkewSamples].sort((a, b) => a.rtt - b.rtt);
            const best = sorted.slice(0, Math.ceil(sorted.length / 2));

            const offsets = best.map(s => s.offset).sort((a, b) => a - b);
            const medianOffset = offsets[Math.floor(offsets.length / 2)];

            const prevCalibrated = this.largeSkewCalibrated;
            this.largeSkewOffset = medianOffset;
            this.largeSkewCalibrated = true;

            if (!prevCalibrated) {
                console.log(`[ClockSync] Large-skew offset calibrated: ${this.largeSkewOffset.toFixed(1)}ms`);
            }

            // Also expose through the standard offset field so callers using
            // this.offset / remoteToLocal() / now() work transparently.
            this.offset = this.largeSkewOffset;
            this.rtt = best.reduce((s, x) => s + x.rtt, 0) / best.length;
            this._updateQuality();

            if (this.onUpdate) {
                this.onUpdate(this.offset, this.rtt, this.quality);
            }
        }
    }

    /**
     * Convert a remote (sender) wall-clock timestamp to local time.
     *
     * Works correctly whether the offset is small (normal NTP) or large
     * (≥ 10 s large-skew calibration).
     *
     * @param {number} remoteMs - Remote wall clock time in ms
     * @returns {number} Equivalent local wall clock time in ms
     */
    remoteToLocal(remoteMs) {
        // remote_time = local_time + offset  →  local_time = remote_time - offset
        return remoteMs - this.offset;
    }

    /**
     * Compute latency from a remote capture timestamp to now (browser display time).
     *
     * This is the primary helper for glass-to-glass latency. It applies the
     * current offset (whether normal NTP or large-skew-calibrated) so a 10 s
     * clock difference does not inflate reported latency.
     *
     *   latency = (T_now_browser) - (T_capture_remote) - offset
     *           = localNow() - remoteMs - offset
     *           = (localNow() - offset) - remoteMs   [server-aligned view]
     */
    calcLatency(remoteCaptureMs) {
        // Convert remote capture time to local clock domain, then measure elapsed.
        const localCapture = this.remoteToLocal(remoteCaptureMs);
        return this.localNow() - localCapture;
    }

    /**
     * Get the current synchronized time (server-aligned).
     * @returns {number} Current time in ms, aligned to server clock
     */
    now() {
        return (performance.now() + performance.timeOrigin) + this.offset;
    }

    /**
     * Get current local wall time in ms.
     * @returns {number}
     */
    localNow() {
        return performance.now() + performance.timeOrigin;
    }

    /**
     * Estimate clock drift rate from offset history.
     * Uses linear regression over recent samples.
     */
    _estimateDrift() {
        if (this.history.length < 10) {
            this.drift = 0;
            return;
        }

        const n = this.history.length;
        const recent = this.history.slice(-20); // last 20 samples

        let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
        const t0 = recent[0].time;

        for (const sample of recent) {
            const x = (sample.time - t0) / 1000; // seconds
            const y = sample.offset;
            sumX += x;
            sumY += y;
            sumXY += x * y;
            sumX2 += x * x;
        }

        const denom = n * sumX2 - sumX * sumX;
        if (Math.abs(denom) > 1e-10) {
            this.drift = (n * sumXY - sumX * sumY) / denom; // ms per second
        }
    }

    /**
     * Update sync quality assessment.
     */
    _updateQuality() {
        if (this.syncCount < 5 && !this.largeSkewCalibrated) {
            this.quality = 'unknown';
        } else if (this.rtt < 10 && Math.abs(this.drift) < 0.5) {
            this.quality = 'excellent';
        } else if (this.rtt < 30 && Math.abs(this.drift) < 1.0) {
            this.quality = 'good';
        } else if (this.rtt < 100) {
            this.quality = 'fair';
        } else {
            this.quality = 'poor';
        }
    }

    /**
     * Get diagnostic info.
     * @returns {Object}
     */
    getStats() {
        return {
            offset: this.offset,
            rtt: this.rtt,
            drift: this.drift,
            quality: this.quality,
            syncCount: this.syncCount,
            historyLength: this.history.length,
            largeSkewCalibrated: this.largeSkewCalibrated,
            largeSkewOffset: this.largeSkewOffset,
            largeSkewSamples: this.largeSkewSamples.length,
        };
    }
}

// Export for use by other modules
window.ClockSync = ClockSync;
