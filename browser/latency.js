/**
 * LatencyTracker - Per-stream latency tracking with Chart.js visualization.
 *
 * Features:
 * - Real-time latency graph with encode/packetize/network/total lines
 * - Configurable red threshold with background color change
 * - Rolling window display (last 60 seconds)
 * - Latency breakdown statistics
 *
 * UPDATED: Decode and render timing now comes from
 * requestVideoFrameCallback metadata instead of RTCPeerConnection
 * stats polling + data-channel-to-display heuristic.
 */
class LatencyTracker {
    constructor(streamId, canvasElement, options = {}) {
        this.streamId = streamId;
        this.canvas = canvasElement;
        this.threshold = options.threshold || 100; // ms

        // Data buffers (rolling window)
        this.maxPoints = options.maxPoints || 120;
        this.data = {
            labels: [],
            encode: [],
            packetize: [],
            network: [],
            decode: [],
            render: [],
            total: [],
        };

        // Current values
        this.current = {
            encode: 0,
            packetize: 0,
            network: 0,
            decode: 0,
            render: 0,
            total: 0,
        };

        // ── CHANGED: Replaced old decode/render tracking fields ──
        // OLD (removed):
        //   this._lastDecodeStats = { totalDecodeTime, framesDecoded, timestamp }
        //   this._decodeTimePerFrame = 0          // from RTCPeerConnection.getStats()
        //   this._lastDisplayTime = 0             // performance.now()
        //   this._lastReceiveTime = 0             // performance.now()
        //   this._renderTime = 0                  // datachannel→display heuristic
        //
        // NEW: Timing from requestVideoFrameCallback metadata
        this._browserLatency = 0;      // EMA of (expectedDisplayTime - receiveTime) in ms
        this._decodeTimePerFrame = 0;  // EMA of metadata.processingDuration in ms
        // ── END CHANGE ──

        // Stats
        this.frameCount = 0;
        this.lastUpdateTime = 0;
        this.fpsCounter = 0;
        this.fps = 0;
        this._fpsInterval = null;

        // Chart
        this.chart = null;
        this._isAlert = false;
        this._initChart();
        this._startFpsCounter();
    }

    _initChart() {
        const ctx = this.canvas.getContext('2d');

        // Threshold line plugin
        const thresholdPlugin = {
            id: 'thresholdBackground',
            beforeDraw: (chart) => {
                const { ctx, chartArea, scales } = chart;
                if (!chartArea || !scales.y) return;

                const thresholdY = scales.y.getPixelForValue(this.threshold);

                // Draw red background above threshold
                if (thresholdY > chartArea.top) {
                    ctx.save();
                    ctx.fillStyle = 'rgba(239, 68, 68, 0.06)';
                    ctx.fillRect(
                        chartArea.left,
                        chartArea.top,
                        chartArea.right - chartArea.left,
                        thresholdY - chartArea.top
                    );
                    ctx.restore();
                }
            }
        };

        this.chart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: this.data.labels,
                datasets: [
                    {
                        label: 'Total',
                        data: this.data.total,
                        borderColor: '#22c55e',
                        backgroundColor: 'rgba(34, 197, 94, 0.1)',
                        borderWidth: 2,
                        fill: false,
                        tension: 0.3,
                        pointRadius: 0,
                        order: 1,
                    },
                    {
                        label: 'Network',
                        data: this.data.network,
                        borderColor: '#f59e0b',
                        borderWidth: 1.5,
                        fill: false,
                        tension: 0.3,
                        pointRadius: 0,
                        order: 2,
                    },
                    {
                        label: 'Encode',
                        data: this.data.encode,
                        borderColor: '#a78bfa',
                        borderWidth: 1.5,
                        fill: false,
                        tension: 0.3,
                        pointRadius: 0,
                        order: 3,
                    },
                    {
                        label: 'Decode',
                        data: this.data.decode,
                        borderColor: '#f472b6',
                        borderWidth: 1.5,
                        fill: false,
                        tension: 0.3,
                        pointRadius: 0,
                        order: 4,
                    },
                    {
                        label: 'Render',
                        data: this.data.render,
                        borderColor: '#34d399',
                        borderWidth: 1,
                        fill: false,
                        tension: 0.3,
                        pointRadius: 0,
                        borderDash: [4, 2],
                        order: 5,
                    },
                    {
                        label: 'Packetize',
                        data: this.data.packetize,
                        borderColor: '#38bdf8',
                        borderWidth: 1,
                        fill: false,
                        tension: 0.3,
                        pointRadius: 0,
                        borderDash: [4, 2],
                        order: 6,
                    },
                    {
                        label: 'Threshold',
                        data: [],
                        borderColor: '#ef4444',
                        borderWidth: 1.5,
                        borderDash: [6, 3],
                        fill: false,
                        pointRadius: 0,
                        order: 0,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: {
                    duration: 0,
                },
                interaction: {
                    intersect: false,
                    mode: 'index',
                },
                plugins: {
                    legend: {
                        display: true,
                        position: 'top',
                        labels: {
                            color: '#8b9ab5',
                            font: { size: 9, family: 'monospace' },
                            boxWidth: 12,
                            boxHeight: 2,
                            padding: 6,
                            filter: (item) => item.text !== 'Threshold',
                        },
                    },
                    tooltip: {
                        enabled: true,
                        backgroundColor: '#151d2e',
                        titleColor: '#e2e8f0',
                        bodyColor: '#8b9ab5',
                        borderColor: '#1e2d3d',
                        borderWidth: 1,
                        titleFont: { family: 'monospace', size: 10 },
                        bodyFont: { family: 'monospace', size: 10 },
                        callbacks: {
                            label: (context) => {
                                if (context.dataset.label === 'Threshold') return null;
                                return `${context.dataset.label}: ${context.parsed.y.toFixed(1)} ms`;
                            }
                        }
                    },
                },
                scales: {
                    x: {
                        display: false,
                    },
                    y: {
                        beginAtZero: true,
                        grid: {
                            color: 'rgba(30, 45, 61, 0.5)',
                        },
                        ticks: {
                            color: '#4a5568',
                            font: { size: 9, family: 'monospace' },
                            callback: (val) => `${val}ms`,
                            maxTicksLimit: 5,
                        },
                    },
                },
            },
            plugins: [thresholdPlugin],
        });
    }

    /**
     * Update latency data with a new frame timestamp message.
     * @param {Object} tsData - Timestamp data from data channel
     * @param {ClockSync} clockSync - Clock sync instance for time conversion
     */
    addSample(tsData, clockSync) {
        const receiveTime = clockSync.localNow();
        const senderWallTime = tsData.wst || tsData.t;

        // ── REMOVED: this._lastReceiveTime = performance.now() ──
        // No longer needed — we don't measure data-channel-to-display gap.

        // Calculate network latency using clock sync
        const adjustedSenderTime = clockSync.remoteToLocal(senderWallTime);
        const networkTime = Math.max(0, receiveTime - adjustedSenderTime);

        // Values from sender (already in ms, measured by GStreamer probes)
        const encodeTime = tsData.enc || 0;
        const packetizeTime = tsData.pkt || 0;
        const senderPipeline = tsData.spl || 0;

        // ── CHANGED: Decode and render now come from metadata ──
        // OLD:
        //   const decodeTime = this._decodeTimePerFrame;  // from RTCStats polling
        //   const renderTime = Math.max(0, this._renderTime - decodeTime);
        //     ↑ this._renderTime was datachannel→display gap which included
        //       jitter buffer, decode queue, and frame misalignment
        //
        // NEW: Use values populated by onFrameDisplayed() from
        // requestVideoFrameCallback metadata:
        //   - _decodeTimePerFrame: from metadata.processingDuration (per-frame)
        //   - _browserLatency: from (expectedDisplayTime - receiveTime)
        //   - render = browserLatency - decode (isolates compositing/display)
        const decodeTime = this._decodeTimePerFrame;
        const renderTime = Math.max(0, this._browserLatency - decodeTime);
        // ── END CHANGE ──

        // Total glass-to-glass: sender pipeline + network + decode + render
        const totalLatency = senderPipeline + networkTime + decodeTime + renderTime;

        // Update current values
        this.current.encode = encodeTime;
        this.current.packetize = packetizeTime;
        this.current.network = networkTime;
        this.current.decode = decodeTime;
        this.current.render = renderTime;
        this.current.total = totalLatency;

        // Add to rolling buffers
        const now = new Date();
        const label = `${now.getMinutes()}:${now.getSeconds().toString().padStart(2, '0')}`;
        this.data.labels.push(label);
        this.data.encode.push(encodeTime);
        this.data.packetize.push(packetizeTime);
        this.data.network.push(networkTime);
        this.data.decode.push(decodeTime);
        this.data.render.push(renderTime);
        this.data.total.push(totalLatency);

        // Trim to max points
        while (this.data.labels.length > this.maxPoints) {
            this.data.labels.shift();
            this.data.encode.shift();
            this.data.packetize.shift();
            this.data.network.shift();
            this.data.decode.shift();
            this.data.render.shift();
            this.data.total.shift();
        }

        // Update threshold line data (dataset index 6)
        this.chart.data.datasets[6].data = new Array(this.data.labels.length).fill(this.threshold);

        // FPS tracking
        this.frameCount++;
        this.fpsCounter++;

        // Check threshold alert
        const isOverThreshold = totalLatency > this.threshold;
        if (isOverThreshold !== this._isAlert) {
            this._isAlert = isOverThreshold;
            this._onAlertChange(isOverThreshold);
        }
    }

    /**
     * Called from requestVideoFrameCallback when a video frame is presented.
     *
     * ── CHANGED SIGNATURE & IMPLEMENTATION ──
     * OLD: onFrameDisplayed()  — no args, measured performance.now() gap
     * NEW: onFrameDisplayed(browserLatency, processingDuration)
     *   @param {number|null} browserLatency - ms from decoder receive to display
     *                         (metadata.expectedDisplayTime - metadata.receiveTime)
     *   @param {number|null} processingDuration - ms actual decode time for this frame
     *                         (metadata.processingDuration * 1000)
     *
     * Both values are EMA-smoothed to filter jitter.
     */
    onFrameDisplayed(browserLatency, processingDuration) {
        // ── OLD CODE (removed):
        //   const now = performance.now();
        //   if (this._lastReceiveTime > 0) {
        //       const displayDelay = now - this._lastReceiveTime;
        //       if (this._renderTime === 0) {
        //           this._renderTime = displayDelay;
        //       } else {
        //           this._renderTime = 0.3 * displayDelay + 0.7 * this._renderTime;
        //       }
        //   }
        //   this._lastDisplayTime = now;

        // ── NEW CODE:
        if (browserLatency != null) {
            // EMA smooth the real browser-side measurement
            if (this._browserLatency === 0) {
                this._browserLatency = browserLatency;
            } else {
                this._browserLatency = 0.3 * browserLatency + 0.7 * this._browserLatency;
            }
        }

        if (processingDuration != null) {
            // EMA smooth decode time — replaces RTCStats polling entirely
            if (this._decodeTimePerFrame === 0) {
                this._decodeTimePerFrame = processingDuration;
            } else {
                this._decodeTimePerFrame = 0.3 * processingDuration + 0.7 * this._decodeTimePerFrame;
            }
        }
    }

    // ── REMOVED: updateDecodeStats() ──
    // OLD: updateDecodeStats(totalDecodeTime, framesDecoded) was called from
    //      App.pollDecodeStats() every 1s, pulling cumulative values from
    //      RTCPeerConnection.getStats(). This gave a 1-second-averaged decode
    //      time that wasn't matched to any specific frame.
    //
    // REPLACED BY: metadata.processingDuration in onFrameDisplayed(), which
    //      gives the actual decode time for the exact frame being displayed.

    /**
     * Update the chart rendering. Call this periodically (e.g., 10 Hz).
     */
    render() {
        if (this.chart) {
            this.chart.update('none'); // no animation for performance
        }
    }

    /**
     * Set the latency threshold.
     * @param {number} thresholdMs
     */
    setThreshold(thresholdMs) {
        this.threshold = thresholdMs;

        // Update threshold line (dataset index 6)
        if (this.chart) {
            this.chart.data.datasets[6].data = new Array(this.data.labels.length).fill(this.threshold);
        }
    }

    /**
     * Handle alert state change.
     * @param {boolean} isAlert
     */
    _onAlertChange(isAlert) {
        // Dispatch custom event for the stream card to style itself
        const event = new CustomEvent('latency-alert', {
            detail: {
                streamId: this.streamId,
                isAlert: isAlert,
                latency: this.current.total,
                threshold: this.threshold,
            },
            bubbles: true,
        });
        this.canvas.dispatchEvent(event);
    }

    /**
     * Start FPS counter interval.
     */
    _startFpsCounter() {
        this._fpsInterval = setInterval(() => {
            this.fps = this.fpsCounter;
            this.fpsCounter = 0;
        }, 1000);
    }

    /**
     * Get current stats summary.
     * @returns {Object}
     */
    getStats() {
        const recent = this.data.total.slice(-30);
        const avg = recent.length > 0
            ? recent.reduce((a, b) => a + b, 0) / recent.length
            : 0;
        const max = recent.length > 0 ? Math.max(...recent) : 0;
        const min = recent.length > 0 ? Math.min(...recent) : 0;

        return {
            current: { ...this.current },
            avg: avg,
            max: max,
            min: min,
            fps: this.fps,
            isAlert: this._isAlert,
            frameCount: this.frameCount,
        };
    }

    /**
     * Clean up.
     */
    destroy() {
        if (this._fpsInterval) clearInterval(this._fpsInterval);
        if (this.chart) {
            this.chart.destroy();
            this.chart = null;
        }
    }
}

// Export
window.LatencyTracker = LatencyTracker;