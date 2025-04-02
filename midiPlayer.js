/**
 * Enhanced MIDI playback module for guitar tablature using Web Audio API with audio synchronization.
 * This implementation creates a rich, guitar-like tone without external libraries
 * and synchronizes MIDI playback with audio playback position.
 */

// Base MIDI notes for each string in standard tuning (E2, A2, D3, G3, B3, E4)
const stringMidi = [40, 45, 50, 55, 59, 64];

/**
 * Creates a short impulse response for a simple reverb effect
 * @param {AudioContext} context - The audio context
 * @param {number} duration - Duration of impulse in seconds
 * @param {number} decay - Decay rate
 * @returns {AudioBuffer} Impulse response buffer
 */
function createReverbImpulse(context, duration = 1.5, decay = 2.0) {
  const sampleRate = context.sampleRate;
  const length = sampleRate * duration;
  const impulse = context.createBuffer(2, length, sampleRate);
  const leftChannel = impulse.getChannelData(0);
  const rightChannel = impulse.getChannelData(1);

  for (let i = 0; i < length; i++) {
    // Decreasing amplitude over time
    const amplitude = Math.pow(1 - i / length, decay);

    // Random value between -1 and 1, multiplied by decreasing amplitude
    const sample = (Math.random() * 2 - 1) * amplitude;

    leftChannel[i] = sample;
    // Slightly different reverb in right channel for stereo effect
    rightChannel[i] = (Math.random() * 2 - 1) * amplitude;
  }

  return impulse;
}

/**
 * Creates reverb effect node
 * @param {AudioContext} context - The audio context
 * @returns {ConvolverNode} Configured reverb node
 */
function createReverb(context) {
  const convolver = context.createConvolver();
  convolver.buffer = createReverbImpulse(context, 1.5, 2.0);
  return convolver;
}

/**
 * Plays the guitar tab as MIDI notes using Web Audio API with enhanced tone.
 * Synchronizes with the audio player position.
 * @param {Array<Array<string>>} guitarTab - 2D array representing the guitar tab.
 * @param {number} hopSize - Hop size in samples used in audio analysis.
 * @param {number} sampleRate - Sample rate of the audio in Hz.
 * @param {HTMLAudioElement} audioPlayer - Audio element to sync with
 * @returns {Promise<{duration: number, stop: Function}>} - Object containing playback duration and stop function
 */
export async function playTabAsMidi(guitarTab, hopSize, sampleRate, audioPlayer = null) {
  // Create a new AudioContext for audio playback
  const audioContext = new AudioContext();

  // Ensure AudioContext is running (requires user gesture in browsers)
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  // Create effect chain
  const masterGain = audioContext.createGain();
  masterGain.gain.value = 0.7; // Increased volume to be heard better alongside song

  // Create a compressor to even out dynamics
  const compressor = audioContext.createDynamicsCompressor();
  compressor.threshold.value = -24;
  compressor.knee.value = 10;
  compressor.ratio.value = 4;
  compressor.attack.value = 0.005;
  compressor.release.value = 0.25;

  // Create a reverb effect for spatial depth
  const reverb = createReverb(audioContext);
  const reverbGain = audioContext.createGain();
  reverbGain.gain.value = 0.15; // Subtle reverb mix

  // Connect the effect chain
  masterGain.connect(compressor);
  masterGain.connect(reverbGain); // Dry path to reverb
  reverbGain.connect(reverb);
  reverb.connect(compressor); // Reverb path to compressor
  compressor.connect(audioContext.destination);

  // Calculate duration of each time step in seconds
  const timePerColumn = hopSize / sampleRate;
  const numColumns = guitarTab[0].length;

  const activeNodes = [];
  const scheduledColumns = new Set();
  let shouldStop = false;

  // Animation frame ID for the scheduler
  let schedulerFrameId = null;

  // Determine if we're in sync mode (with audio player) or standalone mode
  const syncMode = audioPlayer !== null;

  // Track last playback rate to detect changes
  let lastPlaybackRate = syncMode ? audioPlayer.playbackRate : 1.0;

  // Reference time for sync mode
  let startContextTime = 0;
  let startAudioTime = 0;
  let lastCurrentTime = 0;
  let lastLoggedTime = 0;

  /**
   * Creates a complete guitar tone with multiple oscillators and processing
   * @param {number} frequency - Base frequency in Hz
   * @param {number} startTime - Start time in seconds
   * @param {number} duration - Duration in seconds
   * @param {number} stringIndex - Which string (0-5) for panning
   * @param {number} velocity - Note velocity/loudness (0-1)
   * @returns {Object} Object containing the oscillators and control nodes
   */
  function createGuitarTone(frequency, startTime, duration, stringIndex, velocity = 0.8) {
    // Only create tones if not stopped
    if (shouldStop) return null;

    // Primary oscillator (sawtooth) for the main tone
    const osc1 = audioContext.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.setValueAtTime(frequency, startTime);

    // Secondary oscillator (square) for added harmonic richness
    const osc2 = audioContext.createOscillator();
    osc2.type = 'square';
    osc2.frequency.setValueAtTime(frequency * 1.005, startTime); // Slightly detuned

    // Tertiary oscillator (triangle) for a smooth bottom end
    const osc3 = audioContext.createOscillator();
    osc3.type = 'triangle';
    osc3.frequency.setValueAtTime(frequency * 0.5, startTime); // One octave down

    // Oscillator gain balance
    const gainOsc1 = audioContext.createGain();
    gainOsc1.gain.value = 0.5 * velocity;

    const gainOsc2 = audioContext.createGain();
    gainOsc2.gain.value = 0.15 * velocity;

    const gainOsc3 = audioContext.createGain();
    gainOsc3.gain.value = 0.1 * velocity;

    // Main gain node for ADSR envelope
    const noteGain = audioContext.createGain();
    noteGain.gain.setValueAtTime(0, startTime);

    // Scale ADSR timings with duration
    const attackTime = Math.min(0.005, duration / 4);
    const decayTime = Math.min(0.08, duration / 2);
    const releaseTime = Math.min(0.1, duration / 2);

    // Attack: Quick rise (pluck simulation)
    noteGain.gain.linearRampToValueAtTime(velocity, startTime + attackTime);

    // Decay: Fast drop to sustain level
    noteGain.gain.linearRampToValueAtTime(0.3 * velocity, startTime + decayTime);

    // Sustain: Steady level
    noteGain.gain.setValueAtTime(0.3 * velocity, startTime + duration - releaseTime);

    // Release: Smooth fade out
    noteGain.gain.linearRampToValueAtTime(0, startTime + duration + releaseTime);

    // Filter for warmth, removing harsh high frequencies
    const filter = audioContext.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(5000, startTime); // Higher cutoff for clarity
    filter.frequency.linearRampToValueAtTime(2000, startTime + 0.1); // Roll off high frequencies
    filter.Q.value = 1; // Moderate resonance

    // Stereo panning to position strings across the stereo field
    const panner = audioContext.createStereoPanner();
    // Spread strings from left (-0.8) to right (0.8)
    panner.pan.setValueAtTime((stringIndex - 2.5) / 3, startTime);

    // Connect oscillators to their individual gain nodes
    osc1.connect(gainOsc1);
    osc2.connect(gainOsc2);
    osc3.connect(gainOsc3);

    // Connect the oscillator gains to the filter
    gainOsc1.connect(filter);
    gainOsc2.connect(filter);
    gainOsc3.connect(filter);

    // Connect the filter through the envelope to the panner
    filter.connect(noteGain);
    noteGain.connect(panner);

    // Connect panner to master gain
    panner.connect(masterGain);

    // Start all oscillators
    osc1.start(startTime);
    osc2.start(startTime);
    osc3.start(startTime);

    // Stop time with release tail
    const stopTime = startTime + duration + releaseTime;

    // Schedule stops
    osc1.stop(stopTime);
    osc2.stop(stopTime);
    osc3.stop(stopTime);

    // Store all nodes for later cleanup
    const nodes = [osc1, osc2, osc3, gainOsc1, gainOsc2, gainOsc3, noteGain, filter, panner];
    activeNodes.push(...nodes);

    return {
      oscillators: [osc1, osc2, osc3],
      gains: [gainOsc1, gainOsc2, gainOsc3, noteGain],
      filter,
      panner,
      duration: duration,
      stopTime: stopTime
    };
  }

  /**
   * Converts MIDI note number to frequency in Hz
   * @param {number} midi - MIDI note number
   * @returns {number} Frequency in Hz
   */
  function midiToFrequency(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  /**
   * Schedule notes for a specific column in the tab
   * @param {number} col - Column index to schedule
   * @param {number} contextTime - Audio context time to start from
   * @param {number} playbackSpeed - Playback speed multiplier
   */
  function scheduleColumn(col, contextTime, playbackSpeed = 1.0) {
    if (col < 0 || col >= numColumns || scheduledColumns.has(col) || shouldStop) {
      return;
    }

    const startTime = contextTime;
    // Adjust note duration inversely to playback speed (faster = shorter notes)
    // Enforce a minimum duration to ensure all notes are audible
    const noteDuration = Math.max(0.1, (timePerColumn * 1.2) / playbackSpeed);

    // Check each string at this time step
    for (let s = 0; s < 6; s++) {
      const fretValue = guitarTab[s][col];

      if (fretValue !== '-') {
        // Handle sustained note markers (starting with 's')
        let fret;
        let isStartingNote = true;

        if (fretValue.startsWith('s')) {
          // This is a sustained note - extract the fret number after the 's'
          fret = fretValue.substring(1);
          isStartingNote = false;
        } else {
          // This is the start of a note
          fret = fretValue;
        }

        // Calculate MIDI note: base note of string plus fret number
        const baseMidi = stringMidi[s];
        const midiNote = baseMidi + parseInt(fret);
        const frequency = midiToFrequency(midiNote);

        // For sustained notes, we'll use a lower velocity to make them softer
        const velocity = isStartingNote ? 0.8 : 0.6;

        // Create a rich guitar-like tone for this note - but only for starting notes
        if (isStartingNote) {
          // Calculate the total duration by looking ahead to count sustained markers
          let totalDuration = noteDuration;
          let sustainCount = 0;

          // Look ahead to count how many sustained markers follow this note
          for (let nextCol = col + 1; nextCol < numColumns; nextCol++) {
            const nextValue = guitarTab[s][nextCol];
            if (nextValue === `s${fret}`) {
              sustainCount++;
            } else {
              break; // Stop at the first non-matching value
            }
          }

          // Extend the note duration based on sustained columns
          if (sustainCount > 0) {
            totalDuration = noteDuration * (sustainCount + 1);
          }

          createGuitarTone(frequency, startTime, totalDuration, s, velocity);
        }
      }
    }

    // Mark this column as scheduled
    scheduledColumns.add(col);
  }

  /**
   * The scheduler loop that synchronizes MIDI playback with audio
   */
  function scheduleLoop() {
    if (shouldStop) {
      return;
    }

    if (syncMode && audioPlayer) {
      const currentAudioTime = audioPlayer.currentTime;
      const currentPlaybackRate = audioPlayer.playbackRate;

      // If playback rate changed significantly, clear scheduled notes
      if (Math.abs(currentPlaybackRate - lastPlaybackRate) > 0.05) {
        scheduledColumns.clear();
        lastPlaybackRate = currentPlaybackRate;
      }

      // If the audio is actually playing
      if (!audioPlayer.paused) {
        // If we've jumped forward or backward significantly, reset our scheduling
        if (Math.abs(currentAudioTime - lastCurrentTime) > 0.1) {
          // Clear scheduled columns on seek
          scheduledColumns.clear();
        }

        lastCurrentTime = currentAudioTime;

        // Calculate the current column based on audio position
        const currentColumn = Math.floor(currentAudioTime / timePerColumn);

        // Look ahead by 1.0 seconds to ensure smooth playback
        // Adjust lookahead time based on playback rate - need more time at faster speeds
        const lookAheadSeconds = 1.0 * Math.max(1, currentPlaybackRate);
        const lookAheadColumns = Math.ceil(lookAheadSeconds / timePerColumn);

        // Keep track of time for debugging if needed
        if (Math.floor(currentAudioTime) !== Math.floor(lastLoggedTime || 0)) {
          lastLoggedTime = currentAudioTime;
        }

        // Schedule columns from current to current + lookAhead, starting slightly before
        for (let col = currentColumn - 2; col <= currentColumn + lookAheadColumns; col++) {
          if (col >= 0 && col < numColumns && !scheduledColumns.has(col)) {
            // Calculate the precise audio context time for this column
            // Divide by playback rate to schedule notes correctly at different speeds
            const columnOffset = (col - currentColumn) * timePerColumn / currentPlaybackRate;
            let columnContextTime = audioContext.currentTime + columnOffset;
            if (columnContextTime < audioContext.currentTime) {
              columnContextTime = audioContext.currentTime; // Force to now if in past
            }

            scheduleColumn(col, columnContextTime, currentPlaybackRate);
          }
        }
      }

      // Keep the loop running
      schedulerFrameId = requestAnimationFrame(scheduleLoop);
    }
  }

  // If in sync mode, set up the scheduler
  if (syncMode && audioPlayer) {
    // Initialize timing references
    startContextTime = audioContext.currentTime;
    startAudioTime = audioPlayer.currentTime;
    lastCurrentTime = audioPlayer.currentTime;
    lastPlaybackRate = audioPlayer.playbackRate;

    // Clear any previously scheduled columns
    scheduledColumns.clear();

    // Force initial scheduling of notes based on current position
    const currentColumn = Math.floor(audioPlayer.currentTime / timePerColumn);

    // Calculate the precise audio context time for this column
    const initialScheduleTime = audioContext.currentTime + 0.05; // Small delay to ensure scheduling works

    // Pre-schedule a few columns to ensure immediate sound
    for (let col = currentColumn; col < currentColumn + 10 && col < numColumns; col++) {
      const columnOffset = (col - currentColumn) * timePerColumn / audioPlayer.playbackRate;
      scheduleColumn(col, initialScheduleTime + columnOffset, audioPlayer.playbackRate);
    }

    // Start the continuous scheduling loop
    schedulerFrameId = requestAnimationFrame(scheduleLoop);

    // Set up event handlers
    const seekHandler = () => {
      if (!shouldStop) {
        scheduledColumns.clear();
      }
    };

    const pauseHandler = () => {
    };

    const playHandler = () => {
      // Schedule notes at the current position with a slight delay
      const currentColumn = Math.floor(audioPlayer.currentTime / timePerColumn);
      for (let col = currentColumn; col < currentColumn + 5 && col < numColumns; col++) {
        if (!scheduledColumns.has(col)) {
          const columnOffset = (col - currentColumn) * timePerColumn / audioPlayer.playbackRate;
          scheduleColumn(col, audioContext.currentTime + 0.05 + columnOffset, audioPlayer.playbackRate);
        }
      }
    };

    // Handler for playback rate changes
    const ratechangeHandler = () => {
      if (!shouldStop && Math.abs(audioPlayer.playbackRate - lastPlaybackRate) > 0.05) {
        // Clear all scheduled columns and re-compute with new rate
        scheduledColumns.clear();
        lastPlaybackRate = audioPlayer.playbackRate;
      }
    };

    // Add event listeners
    audioPlayer.addEventListener('seeking', seekHandler);
    audioPlayer.addEventListener('pause', pauseHandler);
    audioPlayer.addEventListener('play', playHandler);
    audioPlayer.addEventListener('ratechange', ratechangeHandler);

    // Return cleanup function that removes event listeners
    const stop = () => {
      shouldStop = true;

      if (schedulerFrameId) {
        cancelAnimationFrame(schedulerFrameId);
        schedulerFrameId = null;
      }

      // Remove event listeners
      audioPlayer.removeEventListener('seeking', seekHandler);
      audioPlayer.removeEventListener('pause', pauseHandler);
      audioPlayer.removeEventListener('play', playHandler);
      audioPlayer.removeEventListener('ratechange', ratechangeHandler);

      cleanupAudio();
    };

    return {
      duration: numColumns * timePerColumn,
      stop
    };
  }
  // Otherwise, play all notes immediately (standalone mode)
  else {

    // Get the current time from AudioContext for scheduling
    const now = audioContext.currentTime;

    // Add a slight pause before starting
    const startOffset = 0.1;

    // Playback speed (default 1.0)
    const playbackSpeed = 1.0;

    // Schedule all notes at once
    for (let col = 0; col < numColumns; col++) {
      // Adjust timing by playback speed
      const startTime = now + startOffset + (col * timePerColumn / playbackSpeed);
      // Enforce a minimum duration to ensure all notes are audible
      const noteDuration = Math.max(0.1, (timePerColumn * 1.2) / playbackSpeed);

      // Check each string at this time step
      for (let s = 0; s < 6; s++) {
        const fretValue = guitarTab[s][col];

        if (fretValue !== '-') {
          // Handle sustained note markers (starting with 's')
          let fret;
          let isStartingNote = true;

          if (fretValue.startsWith('s')) {
            // This is a sustained note - extract the fret number after the 's'
            fret = fretValue.substring(1);
            isStartingNote = false;
          } else {
            // This is the start of a note
            fret = fretValue;
          }

          // Calculate MIDI note: base note of string plus fret number
          const baseMidi = stringMidi[s];
          const midiNote = baseMidi + parseInt(fret);
          const frequency = midiToFrequency(midiNote);

          // Only create a new tone for starting notes to avoid retriggering during sustain
          if (isStartingNote) {
            // Calculate the total duration by looking ahead to count sustained markers
            let totalDuration = noteDuration;
            let sustainCount = 0;

            // Look ahead to count how many sustained markers follow this note
            for (let nextCol = col + 1; nextCol < numColumns; nextCol++) {
              const nextValue = guitarTab[s][nextCol];
              if (nextValue === `s${fret}`) {
                sustainCount++;
              } else {
                break; // Stop at the first non-matching value
              }
            }

            // Extend the note duration based on sustained columns
            if (sustainCount > 0) {
              totalDuration = noteDuration * (sustainCount + 1);
            }

            // Velocity slightly higher for stand-alone mode
            const velocity = 0.9;
            createGuitarTone(frequency, startTime, totalDuration, s, velocity);
          }
        }
      }
    }

    // Total duration of playback (adjusted for playback speed)
    const duration = (numColumns * timePerColumn) / playbackSpeed;

    // Return duration and stop function for standalone mode
    return {
      duration: duration + startOffset,
      stop: cleanupAudio
    };
  }

  /**
   * Stops all scheduled and currently playing audio
   */
  function cleanupAudio() {
    // Set the stop flag first
    shouldStop = true;

    // Cancel any ongoing scheduler
    if (schedulerFrameId) {
      cancelAnimationFrame(schedulerFrameId);
      schedulerFrameId = null;
    }

    if (audioContext.state !== 'closed') {
      try {
        // Try to stop all audio nodes
        activeNodes.forEach((node) => {
          if (node.stop) {
            try {
              node.stop(0); // Stop immediately if it's an oscillator
            } catch (e) {
              // Node might already be stopped
            }
          } else if (node.gain) {
            // If it's a gain node, ramp it down
            try {
              node.gain.cancelScheduledValues(audioContext.currentTime);
              node.gain.linearRampToValueAtTime(0, audioContext.currentTime + 0.02);
            } catch (e) {
              // Handle potential errors
            }
          }
        });

        // Fade out master volume quickly to avoid clicks
        masterGain.gain.cancelScheduledValues(audioContext.currentTime);
        masterGain.gain.linearRampToValueAtTime(0, audioContext.currentTime + 0.1);

        // Clear the active nodes array
        activeNodes.length = 0;

        // Close the audio context after a short delay to allow fade-out
        setTimeout(() => {
          try {
            audioContext.close();
          } catch (e) {
            console.error('Error closing audio context:', e);
          }
        }, 200);
      } catch (e) {
        console.error('Error stopping MIDI playback:', e);
      }
    }
  }
}
