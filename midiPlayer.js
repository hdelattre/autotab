// Guitar string tuning in MIDI notes
const STANDARD_TUNING = [40, 45, 50, 55, 59, 64]; // E2, A2, D3, G3, B3, E4

// Note articulation types
const ARTICULATION = {
  NORMAL: 'normal',
  BEND_UP: 'bendUp',
  BEND_DOWN: 'bendDown',
  SLIDE_UP: 'slideUp',
  SLIDE_DOWN: 'slideDown',
  HAMMER_ON: 'hammerOn',
  PULL_OFF: 'pullOff',
  VIBRATO: 'vibrato',
  PALM_MUTE: 'palmMute',
  HARMONIC: 'harmonic'
};

/**
 * Guitar synthesis engine using Web Audio API
 */
class GuitarSynthesizer {
  constructor(audioContext) {
    this.context = audioContext;
    this.strings = [];
    this.masterGain = this.context.createGain();
    this.masterGain.gain.value = 1.0;

    // Create effects chain
    this.compressor = this.createCompressor();
    this.reverb = this.createReverb();
    this.cabinet = this.createCabinetSimulator();

    // Connect effects chain
    this.masterGain.connect(this.compressor);
    this.compressor.connect(this.cabinet);
    this.cabinet.connect(this.context.destination);

    // Reverb send
    this.reverbSend = this.context.createGain();
    this.reverbSend.gain.value = 0.2;
    this.masterGain.connect(this.reverbSend);
    this.reverbSend.connect(this.reverb);
    this.reverb.connect(this.context.destination);

    // Initialize string simulators
    this.initializeStrings();
  }

  initializeStrings() {
    for (let i = 0; i < 6; i++) {
      this.strings[i] = new GuitarString(this.context, i, STANDARD_TUNING[i]);
    }
  }

  createCompressor() {
    const comp = this.context.createDynamicsCompressor();
    comp.threshold.value = -24;
    comp.knee.value = 30;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    return comp;
  }

  createReverb() {
    const convolver = this.context.createConvolver();
    const length = this.context.sampleRate * 2;
    const impulse = this.context.createBuffer(2, length, this.context.sampleRate);

    for (let channel = 0; channel < 2; channel++) {
      const channelData = impulse.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        const decay = Math.pow(1 - i / length, 2);
        channelData[i] = (Math.random() * 2 - 1) * decay;
      }
    }

    convolver.buffer = impulse;
    return convolver;
  }

  createCabinetSimulator() {
    // Simple cabinet simulation using filters
    const lowShelf = this.context.createBiquadFilter();
    lowShelf.type = 'lowshelf';
    lowShelf.frequency.value = 500;
    lowShelf.gain.value = -3;

    const highShelf = this.context.createBiquadFilter();
    highShelf.type = 'highshelf';
    highShelf.frequency.value = 3000;
    highShelf.gain.value = -6;

    const mid = this.context.createBiquadFilter();
    mid.type = 'peaking';
    mid.frequency.value = 1500;
    mid.Q.value = 0.7;
    mid.gain.value = 2;

    lowShelf.connect(highShelf);
    highShelf.connect(mid);

    return lowShelf;
  }

  playNote(stringIndex, fret, startTime, duration, articulation = ARTICULATION.NORMAL, velocity = 0.8) {
    if (stringIndex < 0 || stringIndex >= 6) return null;

    const string = this.strings[stringIndex];
    const note = string.pluck(fret, startTime, duration, velocity, articulation);

    // Connect to master output
    note.output.connect(this.masterGain);

    return note;
  }

  stopAllNotes() {
    this.strings.forEach(string => string.stopAllNotes());
  }

  dispose() {
    this.stopAllNotes();
    this.masterGain.disconnect();
    this.compressor.disconnect();
    this.reverb.disconnect();
    this.cabinet.disconnect();
    this.reverbSend.disconnect();
  }
}

/**
 * Karplus-Strong string synthesis
 */
class KarplusStrongString {
  constructor(context, frequency, duration = 2.0) {
    this.context = context;
    this.frequency = frequency;
    this.duration = duration;

    // Calculate delay line length
    this.sampleRate = context.sampleRate;
    this.delayLength = Math.round(this.sampleRate / frequency);

    // Create nodes
    this.noise = context.createBufferSource();
    this.filter = context.createBiquadFilter();
    this.delay = context.createDelay(1.0);
    this.feedback = context.createGain();
    this.output = context.createGain();

    // Configure filter (lowpass for string damping)
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 2000;
    this.filter.Q.value = 0.5;

    // Configure delay
    this.delay.delayTime.value = this.delayLength / this.sampleRate;

    // Configure feedback (controls decay time)
    // Clamp feedback to prevent runaway feedback
    const decayFactor = Math.pow(0.001, 1 / (duration * frequency));
    this.feedback.gain.value = Math.min(0.98, decayFactor);

    // Create initial noise burst
    const noiseBuffer = this.createNoiseBuffer();
    this.noise.buffer = noiseBuffer;

    // Connect nodes
    this.noise.connect(this.output);
    this.noise.connect(this.delay);
    this.delay.connect(this.filter);
    this.filter.connect(this.feedback);
    this.feedback.connect(this.delay);
    this.feedback.connect(this.output);
  }

  createNoiseBuffer() {
    // Create short burst of filtered noise
    const length = Math.max(64, this.delayLength);
    const buffer = this.context.createBuffer(1, length, this.sampleRate);
    const data = buffer.getChannelData(0);

    // Fill with filtered white noise
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * 0.5;
    }

    // Apply simple lowpass filter to shape pluck
    for (let i = 1; i < length; i++) {
      data[i] = data[i] * 0.5 + data[i-1] * 0.5;
    }

    return buffer;
  }

  pluck(startTime, velocity = 1.0, pluckPosition = 0.9) {
    // Adjust filter based on pluck position (brightness)
    this.filter.frequency.setValueAtTime(
      2000 + 3000 * pluckPosition,
      startTime
    );

    // Start noise burst
    this.noise.start(startTime);
    this.noise.stop(startTime + 0.01); // Very short burst

    // Apply velocity
    this.output.gain.setValueAtTime(velocity, startTime);

    return this.output;
  }

  stop(time) {
    // Quickly damp the string
    this.feedback.gain.exponentialRampToValueAtTime(0.001, time + 0.1);

    // Schedule cleanup
    setTimeout(() => {
      this.noise.disconnect();
      this.filter.disconnect();
      this.delay.disconnect();
      this.feedback.disconnect();
    }, (time - this.context.currentTime + 0.5) * 1000);
  }
}

/**
 * Individual guitar string simulator
 */
class GuitarString {
  constructor(context, index, openNote) {
    this.context = context;
    this.index = index;
    this.openNote = openNote;
    this.activeNotes = [];
    this.useKarplusStrong = false; // Feature flag - disabled due to feedback issues
  }

  pluck(fret, startTime, duration, velocity, articulation) {
    const midiNote = this.openNote + fret;
    const frequency = 440 * Math.pow(2, (midiNote - 69) / 12);

    // Use Karplus-Strong for normal notes if enabled
    if (this.useKarplusStrong && articulation === ARTICULATION.NORMAL) {
      return this.createKarplusStrongNote(frequency, startTime, duration, velocity);
    }

    // Create note based on articulation
    let note;
    switch (articulation) {
      case ARTICULATION.BEND_UP:
        note = this.createBendNote(frequency, startTime, duration, velocity, 1);
        break;
      case ARTICULATION.BEND_DOWN:
        note = this.createBendNote(frequency, startTime, duration, velocity, -1);
        break;
      case ARTICULATION.SLIDE_UP:
        note = this.createSlideNote(frequency, startTime, duration, velocity, 1);
        break;
      case ARTICULATION.SLIDE_DOWN:
        note = this.createSlideNote(frequency, startTime, duration, velocity, -1);
        break;
      case ARTICULATION.VIBRATO:
        note = this.createVibratoNote(frequency, startTime, duration, velocity);
        break;
      case ARTICULATION.PALM_MUTE:
        note = this.createPalmMuteNote(frequency, startTime, duration, velocity);
        break;
      case ARTICULATION.HARMONIC:
        note = this.createHarmonicNote(frequency, startTime, duration, velocity);
        break;
      default:
        note = this.createNormalNote(frequency, startTime, duration, velocity);
    }

    this.activeNotes.push(note);

    // Schedule cleanup
    setTimeout(() => {
      const index = this.activeNotes.indexOf(note);
      if (index > -1) {
        this.activeNotes.splice(index, 1);
      }
    }, (duration + 2) * 1000);

    return note;
  }

  createKarplusStrongNote(frequency, startTime, duration, velocity) {
    const note = new GuitarNote(this.context);

    // Create Karplus-Strong string
    const string = new KarplusStrongString(this.context, frequency, duration);
    const output = string.pluck(startTime, velocity);

    // Add some body resonance
    const bodyFilter = this.context.createBiquadFilter();
    bodyFilter.type = 'peaking';
    bodyFilter.frequency.value = 100;
    bodyFilter.Q.value = 2;
    bodyFilter.gain.value = 3;

    output.connect(bodyFilter);

    note.string = string;
    note.output = bodyFilter;

    return note;
  }

  createNormalNote(frequency, startTime, duration, velocity) {
    const note = new GuitarNote(this.context);

    // Create oscillators
    const fundamental = this.context.createOscillator();
    fundamental.type = 'sawtooth';
    fundamental.frequency.setValueAtTime(frequency, startTime);

    const octave = this.context.createOscillator();
    octave.type = 'square';
    octave.frequency.setValueAtTime(frequency * 2, startTime);

    // Create envelope
    const envelope = this.context.createGain();
    envelope.gain.setValueAtTime(0, startTime);
    envelope.gain.linearRampToValueAtTime(velocity, startTime + 0.002);
    envelope.gain.exponentialRampToValueAtTime(velocity * 0.3, startTime + 0.05);
    envelope.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

    // Create filter
    const filter = this.context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2000 + frequency, startTime);
    filter.frequency.exponentialRampToValueAtTime(1000, startTime + duration);
    filter.Q.value = 2;

    // Oscillator gains
    const fundGain = this.context.createGain();
    fundGain.gain.value = 0.7;

    const octaveGain = this.context.createGain();
    octaveGain.gain.value = 0.2;

    // Connect
    fundamental.connect(fundGain);
    octave.connect(octaveGain);
    fundGain.connect(filter);
    octaveGain.connect(filter);
    filter.connect(envelope);

    // Start and stop
    fundamental.start(startTime);
    octave.start(startTime);
    fundamental.stop(startTime + duration + 0.5);
    octave.stop(startTime + duration + 0.5);

    note.oscillators = [fundamental, octave];
    note.output = envelope;

    return note;
  }

  createBendNote(frequency, startTime, duration, velocity, direction) {
    const note = this.createNormalNote(frequency, startTime, duration, velocity);

    // Add pitch bend
    const bendAmount = direction > 0 ? 200 : -200; // cents
    const targetFreq = frequency * Math.pow(2, bendAmount / 1200);

    note.oscillators.forEach((osc, i) => {
      const baseFreq = i === 0 ? frequency : frequency * 2;
      const targetOscFreq = i === 0 ? targetFreq : targetFreq * 2;

      osc.frequency.setValueAtTime(baseFreq, startTime);
      osc.frequency.exponentialRampToValueAtTime(targetOscFreq, startTime + duration * 0.3);
      osc.frequency.setValueAtTime(targetOscFreq, startTime + duration * 0.7);
      osc.frequency.exponentialRampToValueAtTime(baseFreq, startTime + duration);
    });

    return note;
  }

  createSlideNote(frequency, startTime, duration, velocity, direction) {
    const note = this.createNormalNote(frequency, startTime, duration, velocity);

    // Slide from/to adjacent fret
    const slideAmount = direction > 0 ? -100 : 100; // cents
    const startFreq = frequency * Math.pow(2, slideAmount / 1200);

    note.oscillators.forEach((osc, i) => {
      const baseFreq = i === 0 ? frequency : frequency * 2;
      const slideStartFreq = i === 0 ? startFreq : startFreq * 2;

      osc.frequency.setValueAtTime(slideStartFreq, startTime);
      osc.frequency.exponentialRampToValueAtTime(baseFreq, startTime + duration * 0.2);
    });

    return note;
  }

  createVibratoNote(frequency, startTime, duration, velocity) {
    const note = this.createNormalNote(frequency, startTime, duration, velocity);

    // Add vibrato using LFO
    const lfo = this.context.createOscillator();
    lfo.frequency.value = 5; // 5 Hz vibrato

    const lfoGain = this.context.createGain();
    lfoGain.gain.value = frequency * 0.02; // 2% pitch variation

    lfo.connect(lfoGain);

    note.oscillators.forEach(osc => {
      lfoGain.connect(osc.frequency);
    });

    lfo.start(startTime + 0.1); // Delay vibrato slightly
    lfo.stop(startTime + duration + 0.5);

    return note;
  }

  createPalmMuteNote(frequency, startTime, duration, velocity) {
    if (this.useKarplusStrong) {
      const note = new GuitarNote(this.context);

      // Create heavily damped Karplus-Strong string
      const string = new KarplusStrongString(this.context, frequency, duration * 0.3);

      // Override damping for palm mute effect
      string.feedback.gain.value *= 0.5; // More damping
      string.filter.frequency.value = 500; // Lower cutoff

      const output = string.pluck(startTime, velocity * 0.7, 0.3); // Pluck near bridge

      note.string = string;
      note.output = output;

      return note;
    }

    const note = this.createNormalNote(frequency, startTime, duration * 0.3, velocity * 0.7);

    // Heavily filtered for muted sound
    const muteFilter = this.context.createBiquadFilter();
    muteFilter.type = 'lowpass';
    muteFilter.frequency.value = 500;
    muteFilter.Q.value = 5;

    note.output.connect(muteFilter);
    note.output = muteFilter;

    return note;
  }

  createHarmonicNote(frequency, startTime, duration, velocity) {
    const note = new GuitarNote(this.context);

    // Natural harmonics at 12th, 7th, and 5th frets
    const harmonic = this.context.createOscillator();
    harmonic.type = 'sine';
    harmonic.frequency.setValueAtTime(frequency * 2, startTime); // Octave harmonic

    const envelope = this.context.createGain();
    envelope.gain.setValueAtTime(0, startTime);
    envelope.gain.linearRampToValueAtTime(velocity * 0.5, startTime + 0.001);
    envelope.gain.exponentialRampToValueAtTime(0.001, startTime + duration * 1.5);

    harmonic.connect(envelope);
    harmonic.start(startTime);
    harmonic.stop(startTime + duration * 1.5);

    note.oscillators = [harmonic];
    note.output = envelope;

    return note;
  }

  stopAllNotes() {
    this.activeNotes.forEach(note => {
      if (note.string && note.string instanceof KarplusStrongString) {
        // Stop Karplus-Strong string
        note.string.stop(this.context.currentTime);
      } else if (note.oscillators) {
        // Stop regular oscillators
        note.oscillators.forEach(osc => {
          try {
            osc.stop();
          } catch (e) {
            // Already stopped
          }
        });
      }
    });
    this.activeNotes = [];
  }
}

/**
 * Guitar note container
 */
class GuitarNote {
  constructor(context) {
    this.context = context;
    this.oscillators = [];
    this.output = null;
    this.string = null; // For Karplus-Strong strings
  }
}

/**
 * Enhanced MIDI Player for guitar tablature
 */
export class MidiPlayer {
  constructor(audioContext) {
    this.context = audioContext;
    this.synthesizer = new GuitarSynthesizer(this.context);
    this.scheduledNotes = [];
    this.isPlaying = false;
    this.startTime = 0;
    this.currentTime = 0;
    this.playbackRate = 1.0;
    this.syncSource = null;
    this.animationFrame = null;

    // For unified clock integration
    this.useUnifiedClock = true;
    this.clockOffset = 0;
  }

  /**
   * Get current time for unified clock
   */
  getCurrentTime() {
    return this.currentTime;
  }

  /**
   * Seek to time (called by unified clock)
   */
  seek(time) {
    this.currentTime = time;
    if (this.isPlaying) {
      this.clearScheduledNotes();
    }
  }

  /**
   * Play guitar tablature
   * @param {Array<Array<string>>} guitarTab - 6xN array of fret values
   * @param {number} hopSize - Samples per column
   * @param {number} sampleRate - Sample rate
   * @param {HTMLAudioElement} audioElement - Optional audio element for sync
   * @param {number} startPosition - Start position in seconds
   * @param {number} playbackRate - Playback speed multiplier
   */
  async play(guitarTab, hopSize, sampleRate, audioElement = null, startPosition = 0, playbackRate = 1.0) {
    if (this.isPlaying) {
      this.stop();
    }

    // Resume context if needed
    if (this.context.state === 'suspended') {
      await this.context.resume();
    }

    this.isPlaying = true;
    this.playbackRate = playbackRate;
    this.syncSource = audioElement;
    this.startTime = this.context.currentTime;
    this.currentTime = startPosition;

    const timePerColumn = hopSize / sampleRate;
    const duration = guitarTab[0].length * timePerColumn;

    if (audioElement) {
      // Synchronized playback - start immediately
      this.scheduleWithSync(guitarTab, timePerColumn, audioElement);
    } else {
      // Standalone playback
      this.scheduleStandalone(guitarTab, timePerColumn, startPosition);
    }

    return {
      duration: duration,
      stop: () => this.stop(),
      seek: (time) => this.seek(time),
      setPlaybackRate: (rate) => this.setPlaybackRate(rate)
    };
  }

  scheduleWithSync(guitarTab, timePerColumn, audioElement) {
    const scheduleAhead = 1.0; // Schedule 1 second ahead for better reliability
    let lastScheduledTime = -1;
    const syncOffset = -0.05; // Offset in seconds to compensate for processing delay (negative = earlier)

    const scheduleNotes = () => {
      if (!this.isPlaying) return;

      const currentAudioTime = audioElement.currentTime;
      const currentContextTime = this.context.currentTime;
      const scheduleUntil = currentAudioTime + scheduleAhead;

      // Clear old scheduled notes if we've seeked
      if (Math.abs(currentAudioTime - lastScheduledTime) > 1.0) {
        this.clearScheduledNotes();
        lastScheduledTime = currentAudioTime - 0.1; // Reset to just before current time
      }

      // Schedule new notes
      for (let col = 0; col < guitarTab[0].length; col++) {
        const noteTime = col * timePerColumn;

        if (noteTime > lastScheduledTime && noteTime <= scheduleUntil) {
          // Calculate when this note should play in context time
          const deltaTime = noteTime - currentAudioTime + syncOffset;
          const contextTime = currentContextTime + deltaTime;

          // Only schedule if it's in the future (with small buffer)
          if (contextTime > currentContextTime - 0.005) {
            this.scheduleColumn(guitarTab, col, contextTime, timePerColumn);
          }
          lastScheduledTime = noteTime;
        }
      }

      this.animationFrame = requestAnimationFrame(scheduleNotes);
    };

    scheduleNotes();
  }

  scheduleStandalone(guitarTab, timePerColumn, startPosition) {
    const startColumn = Math.floor(startPosition / timePerColumn);
    const contextStartTime = this.context.currentTime;

    // Schedule all notes
    for (let col = startColumn; col < guitarTab[0].length; col++) {
      const noteTime = col * timePerColumn;
      const scheduleTime = contextStartTime + (noteTime - startPosition) / this.playbackRate;

      this.scheduleColumn(guitarTab, col, scheduleTime, timePerColumn / this.playbackRate);
    }

    // Update virtual time
    this.updateVirtualTime(startPosition);
  }

  scheduleColumn(guitarTab, column, when, duration) {
    for (let string = 0; string < 6; string++) {
      const fretData = guitarTab[string][column];

      if (fretData && fretData !== '-' && fretData !== '~') {
        // Parse fret and articulation
        const { fret, articulation } = this.parseFretData(fretData);

        if (fret !== null) {
          // Check if this is the start of a sustained note
          let sustainDuration = duration;
          let col = column + 1;

          while (col < guitarTab[0].length && guitarTab[string][col] === '~') {
            sustainDuration += duration;
            col++;
          }

          // Schedule the note
          const note = this.synthesizer.playNote(
            string,
            fret,
            when,
            sustainDuration,
            articulation,
            0.8
          );

          if (note) {
            this.scheduledNotes.push({
              note: note,
              endTime: when + sustainDuration
            });
          }
        }
      }
    }
  }

  parseFretData(fretData) {
    // Parse fret number and articulation markers
    let fret = null;
    let articulation = ARTICULATION.NORMAL;

    // Handle string input
    const fretStr = String(fretData).trim();

    // Remove articulation markers and extract fret number
    const match = fretStr.match(/^(\d+)([bhHrp~]*)$/);

    if (match) {
      fret = parseInt(match[1]);
      const markers = match[2];

      if (markers.includes('b')) {
        articulation = ARTICULATION.BEND_UP;
      } else if (markers.includes('r')) {
        articulation = ARTICULATION.BEND_DOWN;
      } else if (markers.includes('h') || markers.includes('H')) {
        articulation = ARTICULATION.HAMMER_ON;
      } else if (markers.includes('p')) {
        articulation = ARTICULATION.PULL_OFF;
      } else if (markers.includes('~')) {
        articulation = ARTICULATION.VIBRATO;
      }
    } else if (/^\d+$/.test(fretStr)) {
      // Just a number with no markers
      fret = parseInt(fretStr);
    }

    return { fret, articulation };
  }

  updateVirtualTime(startTime) {
    const startContextTime = this.context.currentTime;

    const update = () => {
      if (!this.isPlaying || this.syncSource) return;

      const elapsed = (this.context.currentTime - startContextTime) * this.playbackRate;
      this.currentTime = startTime + elapsed;

      // Dispatch time update event
      window.dispatchEvent(new CustomEvent('midiTimeUpdate', {
        detail: {
          currentTime: this.currentTime,
          isPlaying: true
        }
      }));

      this.animationFrame = requestAnimationFrame(update);
    };

    update();
  }

  clearScheduledNotes() {
    const now = this.context.currentTime;

    this.scheduledNotes = this.scheduledNotes.filter(item => {
      if (item.endTime < now) {
        return false;
      }
      return true;
    });
  }

  stop() {
    this.isPlaying = false;

    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }

    this.synthesizer.stopAllNotes();
    this.scheduledNotes = [];

    // Dispatch stop event
    window.dispatchEvent(new CustomEvent('midiTimeUpdate', {
      detail: {
        isPlaying: false
      }
    }));
  }

  seek(time) {
    if (this.isPlaying) {
      this.currentTime = time;
      this.clearScheduledNotes();
    }
  }

  setPlaybackRate(rate) {
    this.playbackRate = rate;
  }

  dispose() {
    this.stop();
    this.synthesizer.dispose();
  }
}

/**
 * Main entry point for playing tab as MIDI
 */
export async function playTabAsMidi(guitarTab, hopSize, sampleRate, audioPlayer = null, startTime = 0, playbackRate = 1.0) {
  const audioContext = new AudioContext();

  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  const player = new MidiPlayer(audioContext);

  return player.play(guitarTab, hopSize, sampleRate, audioPlayer, startTime, playbackRate);
}