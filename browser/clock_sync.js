/**
 * ClockSync - NTP-style clock synchronization with drift compensation.
 *
 * Maintains synchronized time between browser and signaling server
 * using periodic ping/pong exchanges. Uses exponential moving average
 * to smooth out offset estimates and detect drift.
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
        this.quality = 'unknown'; // 'good', 'fair', 'poor', 'unknown'

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
     *   rtt = (t4 - t1) - (t3 - t2)
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

        // Reject outliers (RTT > 3x current average, minimum 50ms threshold)
        // Without minimum threshold, an unrealistically low initial RTT causes
        // every subsequent sample to be rejected as an outlier.
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
     * Convert a remote (sender) wall-clock timestamp to local time.
     * @param {number} remoteMs - Remote wall clock time in ms
     * @returns {number} Equivalent local wall clock time in ms
     */
    remoteToLocal(remoteMs) {
        // remote_time = local_time + offset
        // local_time = remote_time - offset
        return remoteMs - this.offset;
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

        // Simple linear regression: offset = drift * time + intercept
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
        if (this.syncCount < 5) {
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
        };
    }
}

// Export for use by other modules
window.ClockSync = ClockSync;