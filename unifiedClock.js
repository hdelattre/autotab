/**
 * Unified Clock System for perfect audio/MIDI synchronization
 * Uses Web Audio API's hardware clock for sample-accurate timing
 */
export class UnifiedClock {
  constructor(audioContext) {
    this.context = audioContext;
    this.startTime = 0;
    this.pauseTime = 0;
    this.isPlaying = false;
    this.playbackRate = 1.0;
    this.subscribers = new Set();
    this.syncSources = new Map();

    // High-resolution timing
    this.contextStartTime = 0;
    this.performanceStartTime = 0;

    // Clock state
    this.state = {
      currentTime: 0,
      duration: 0,
      isPlaying: false,
      isSeeking: false
    };

    // Update interval
    this.updateInterval = null;
    this.lastUpdateTime = 0;

    // Bind methods
    this.update = this.update.bind(this);
  }

  /**
   * Register a sync source (audio element, MIDI player, etc.)
   */
  registerSyncSource(id, source, config = {}) {
    this.syncSources.set(id, {
      source,
      type: config.type || 'follower',
      priority: config.priority || 0,
      offset: config.offset || 0,
      ...config
    });

    // Set up event listeners based on source type
    if (source instanceof HTMLAudioElement) {
      this.setupAudioElementSync(id, source);
    }
  }

  /**
   * Setup synchronization with HTML audio element
   */
  setupAudioElementSync(id, audioElement) {
    const handlers = {
      play: () => this.handleAudioPlay(id),
      pause: () => this.handleAudioPause(id),
      seeking: () => this.handleAudioSeeking(id),
      seeked: () => this.handleAudioSeeked(id),
      ratechange: () => this.handleAudioRateChange(id),
      ended: () => this.handleAudioEnded(id)
    };

    // Store handlers for cleanup
    this.syncSources.get(id).handlers = handlers;

    // Add listeners
    Object.entries(handlers).forEach(([event, handler]) => {
      audioElement.addEventListener(event, handler);
    });
  }

  /**
   * Handle audio play event
   */
  handleAudioPlay(id) {
    const syncInfo = this.syncSources.get(id);
    if (syncInfo.type === 'master') {
      this.start();
    }
  }

  /**
   * Handle audio pause event
   */
  handleAudioPause(id) {
    const syncInfo = this.syncSources.get(id);
    if (syncInfo.type === 'master') {
      this.pause();
    }
  }

  /**
   * Handle audio seeking
   */
  handleAudioSeeking(id) {
    const syncInfo = this.syncSources.get(id);
    if (syncInfo.type === 'master') {
      this.state.isSeeking = true;
      const audioElement = syncInfo.source;
      this.seek(audioElement.currentTime);
    }
  }

  /**
   * Handle audio seeked
   */
  handleAudioSeeked(id) {
    const syncInfo = this.syncSources.get(id);
    if (syncInfo.type === 'master') {
      this.state.isSeeking = false;
    }
  }

  /**
   * Handle audio rate change
   */
  handleAudioRateChange(id) {
    const syncInfo = this.syncSources.get(id);
    if (syncInfo.type === 'master') {
      const audioElement = syncInfo.source;
      this.setPlaybackRate(audioElement.playbackRate);
    }
  }

  /**
   * Handle audio ended
   */
  handleAudioEnded(id) {
    const syncInfo = this.syncSources.get(id);
    if (syncInfo.type === 'master') {
      this.stop();
    }
  }

  /**
   * Start the clock
   */
  start() {
    if (this.isPlaying) return;

    this.isPlaying = true;
    this.contextStartTime = this.context.currentTime;
    this.performanceStartTime = performance.now() / 1000;

    // Account for pause offset
    if (this.pauseTime > 0) {
      const pauseOffset = this.pauseTime - this.startTime;
      this.startTime = this.contextStartTime - pauseOffset;
      this.pauseTime = 0;
    } else {
      this.startTime = this.contextStartTime;
    }

    // Start update loop
    this.startUpdateLoop();

    // Notify subscribers
    this.notifyStateChange();
  }

  /**
   * Pause the clock
   */
  pause() {
    if (!this.isPlaying) return;

    this.isPlaying = false;
    this.pauseTime = this.context.currentTime;

    // Stop update loop
    this.stopUpdateLoop();

    // Update state
    this.update();

    // Notify subscribers
    this.notifyStateChange();
  }

  /**
   * Stop the clock
   */
  stop() {
    this.isPlaying = false;
    this.startTime = 0;
    this.pauseTime = 0;
    this.state.currentTime = 0;

    // Stop update loop
    this.stopUpdateLoop();

    // Notify subscribers
    this.notifyStateChange();
  }

  /**
   * Seek to a specific time
   */
  seek(time) {
    const wasPlaying = this.isPlaying;

    // Update internal state
    this.state.currentTime = time;

    if (this.isPlaying) {
      // Recalculate start time
      this.startTime = this.context.currentTime - (time / this.playbackRate);
    } else {
      // Update pause state
      this.pauseTime = this.startTime + (time / this.playbackRate);
    }

    // Sync all followers
    this.syncFollowers(time);

    // Notify subscribers
    this.notifyStateChange();
  }

  /**
   * Set playback rate
   */
  setPlaybackRate(rate) {
    const currentTime = this.getCurrentTime();

    this.playbackRate = rate;

    // Recalculate start time to maintain current position
    if (this.isPlaying) {
      this.startTime = this.context.currentTime - (currentTime / rate);
    }

    // Sync all sources
    this.syncSources.forEach((syncInfo, id) => {
      if (syncInfo.source.playbackRate !== undefined) {
        syncInfo.source.playbackRate = rate;
      }
    });

    // Notify subscribers
    this.notifyStateChange();
  }

  /**
   * Get current time with high precision
   */
  getCurrentTime() {
    if (!this.isPlaying) {
      return this.state.currentTime;
    }

    const elapsed = (this.context.currentTime - this.startTime) * this.playbackRate;
    return Math.max(0, Math.min(elapsed, this.state.duration));
  }

  /**
   * Set duration
   */
  setDuration(duration) {
    this.state.duration = duration;
    this.notifyStateChange();
  }

  /**
   * Update loop for state synchronization
   */
  update() {
    const now = performance.now() / 1000;

    // Limit update rate
    if (now - this.lastUpdateTime < 0.016) return; // ~60fps

    this.lastUpdateTime = now;

    // Update current time
    const currentTime = this.getCurrentTime();

    if (Math.abs(currentTime - this.state.currentTime) > 0.001) {
      this.state.currentTime = currentTime;
      this.state.isPlaying = this.isPlaying;

      // Dispatch event for UI updates
      window.dispatchEvent(new CustomEvent('unifiedClockUpdate', {
        detail: {
          currentTime: currentTime,
          duration: this.state.duration,
          isPlaying: this.isPlaying,
          playbackRate: this.playbackRate
        }
      }));
    }

    // Sync followers if needed
    if (this.isPlaying) {
      this.checkSyncDrift();
    }
  }

  /**
   * Check and correct sync drift
   */
  checkSyncDrift() {
    const masterTime = this.state.currentTime;

    this.syncSources.forEach((syncInfo, id) => {
      if (syncInfo.type === 'follower' && syncInfo.source) {
        const sourceTime = this.getSourceTime(syncInfo.source);
        const drift = Math.abs(sourceTime - masterTime);

        // Correct drift if > 50ms
        if (drift > 0.05) {
          this.syncSource(id, masterTime);
        }
      }
    });
  }

  /**
   * Get time from a sync source
   */
  getSourceTime(source) {
    if (source instanceof HTMLAudioElement) {
      return source.currentTime;
    } else if (source.getCurrentTime) {
      return source.getCurrentTime();
    }
    return 0;
  }

  /**
   * Sync a specific source
   */
  syncSource(id, time) {
    const syncInfo = this.syncSources.get(id);
    if (!syncInfo) return;

    const adjustedTime = time + syncInfo.offset;

    if (syncInfo.source instanceof HTMLAudioElement) {
      syncInfo.source.currentTime = adjustedTime;
    } else if (syncInfo.source.seek) {
      syncInfo.source.seek(adjustedTime);
    }
  }

  /**
   * Sync all follower sources
   */
  syncFollowers(time) {
    this.syncSources.forEach((syncInfo, id) => {
      if (syncInfo.type === 'follower') {
        this.syncSource(id, time);
      }
    });
  }

  /**
   * Start update loop
   */
  startUpdateLoop() {
    if (this.updateInterval) return;

    const updateFn = () => {
      this.update();
      this.updateInterval = requestAnimationFrame(updateFn);
    };

    updateFn();
  }

  /**
   * Stop update loop
   */
  stopUpdateLoop() {
    if (this.updateInterval) {
      cancelAnimationFrame(this.updateInterval);
      this.updateInterval = null;
    }
  }

  /**
   * Subscribe to clock updates
   */
  subscribe(callback) {
    this.subscribers.add(callback);

    // Return unsubscribe function
    return () => {
      this.subscribers.delete(callback);
    };
  }

  /**
   * Notify all subscribers of state change
   */
  notifyStateChange() {
    const state = {
      currentTime: this.state.currentTime,
      duration: this.state.duration,
      isPlaying: this.isPlaying,
      playbackRate: this.playbackRate,
      isSeeking: this.state.isSeeking
    };

    this.subscribers.forEach(callback => {
      try {
        callback(state);
      } catch (error) {
        console.error('Clock subscriber error:', error);
      }
    });
  }

  /**
   * Cleanup
   */
  dispose() {
    // Stop updates
    this.stopUpdateLoop();

    // Remove event listeners
    this.syncSources.forEach((syncInfo, id) => {
      if (syncInfo.handlers && syncInfo.source) {
        Object.entries(syncInfo.handlers).forEach(([event, handler]) => {
          syncInfo.source.removeEventListener(event, handler);
        });
      }
    });

    // Clear references
    this.syncSources.clear();
    this.subscribers.clear();
  }
}