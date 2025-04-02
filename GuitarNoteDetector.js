export default class GuitarNoteDetector {
  constructor(
    sampleRate,
    fftSize,
    hopSize,
    fftInstance,
    cqtBinsPerOctave,
    cqtOctaves,
    minMidi,
    thresholdConfig = {},
    harmonicConfig = {},
    trackingConfig = {},
    tabConfig = {}
  ) {
    // Core parameters
    this.sampleRate = sampleRate;
    this.fftSize = fftSize;
    this.hopSize = hopSize;
    this.fftInstance = fftInstance;
    this.cqtBinsPerOctave = cqtBinsPerOctave;
    this.cqtOctaves = cqtOctaves;
    this.minMidi = minMidi;
    this.cqtTotalBins = cqtBinsPerOctave * cqtOctaves;

    // Thresholding parameters
    this.thresholdConfig = {
      absoluteThreshold: 0.005,
      adaptiveThresholdFactor: 1.5,
      adaptiveReferencePercentile: 0.75,
      ...thresholdConfig
    };

    // Harmonic filtering parameters
    this.harmonicConfig = {
      harmonicTolerance: 0.05,
      harmonicSuppressionFactor: 3.0,
      ...harmonicConfig
    };

    // Note tracking parameters
    this.trackingConfig = {
      maxGapFrames: 2,
      minNoteDuration: 0.08,
      maxGapTime: 0.1, // Added for pitch continuity (in seconds)
      ...trackingConfig
    };

    // Tab generation parameters
    this.tabConfig = {
      stringMidi: [40, 45, 50, 55, 59, 64], // E2, A2, D3, G3, B3, E4
      maxFret: 24,
      ...tabConfig
    };

    // Set direct access properties
    this.stringMidi = this.tabConfig.stringMidi;
    this.maxFret = this.tabConfig.maxFret;

    // Create window function for FFT
    this.window = new Float32Array(fftSize).map((_, i) => 0.5 * (1 - Math.cos((2 * Math.PI * i) / (fftSize - 1))));
  }

  async init() {
    const minFreq = 440 * Math.pow(2, (this.minMidi - 69) / 12);
    await this.fftInstance.initCQT(this.cqtBinsPerOctave, this.cqtOctaves, this.sampleRate, minFreq);
  }

  computeCQTFrames(audioBuffer) {
    this.cqtFrames = [];
    for (let offset = 0; offset + this.fftSize <= audioBuffer.length; offset += this.hopSize) {
      const segment = audioBuffer.subarray(offset, offset + this.fftSize);
      const windowed = new Float32Array(this.fftSize).map((v, i) => segment[i] * this.window[i]);
      const cqtResult = this.fftInstance.cqt(windowed);
      this.cqtFrames.push(new Float32Array(this.cqtTotalBins).map((_, k) => Math.hypot(cqtResult.real[k], cqtResult.imag[k])));
    }
    this.duration = audioBuffer.length / this.sampleRate;
  }

  detectNotes() {
    this.notes = [];
    const activeNotes = new Map();
    const timePerFrame = this.hopSize / this.sampleRate;
    this.previousEnergy = 0; // For onset detection

    this.cqtFrames.forEach((magnitude, idx) => {
      // Spectral flatness for adaptive thresholding
      const spectralFlatness = this.calculateSpectralFlatness(magnitude);
      const flatnessFactor = spectralFlatness < 0.1 ? 1.5 : 1.0; // Boost for tonal content
      const sortedMagnitudes = [...magnitude].sort((a, b) => a - b);
      const referenceIndex = Math.floor(sortedMagnitudes.length * this.thresholdConfig.adaptiveReferencePercentile);
      const referenceMagnitude = referenceIndex < sortedMagnitudes.length ? sortedMagnitudes[referenceIndex] : 0;
      const adaptiveComponent = this.thresholdConfig.adaptiveThresholdFactor * referenceMagnitude * flatnessFactor;
      const threshold = Math.max(this.thresholdConfig.absoluteThreshold, adaptiveComponent);

      // Onset detection
      const energy = magnitude.reduce((sum, val) => sum + val * val, 0);
      const isOnset = idx > 0 && energy > 2 * this.previousEnergy;
      this.previousEnergy = energy;

      // Peak picking with interpolation
      const potentialPeaks = [];
      for (let k = 1; k < this.cqtTotalBins - 1; k++) {
        if (magnitude[k] > magnitude[k - 1] && magnitude[k] > magnitude[k + 1] && magnitude[k] > threshold) {
          const y_minus = magnitude[k - 1];
          const y_0 = magnitude[k];
          const y_plus = magnitude[k + 1];
          const denominator = y_minus - 2 * y_0 + y_plus;
          const p = Math.abs(denominator) > 1e-6 ? 0.5 * (y_minus - y_plus) / denominator : 0;
          const interpolatedBin = k + p;
          const interpolatedMagnitude = y_0 - 0.25 * (y_minus - y_plus) * p;
          potentialPeaks.push({ bin: interpolatedBin, magnitude: interpolatedMagnitude });
        }
      }

      // Harmonic filtering
      const sortedPeaks = [...potentialPeaks].sort((a, b) => a.bin - b.bin);
      const confirmedPeaks = [];
      for (const peak of sortedPeaks) {
        let isHarmonic = false;
        for (const fundamental of confirmedPeaks) {
          const freqRatio = peak.bin / fundamental.bin;
          for (let harmonic = 2; harmonic <= 5; harmonic++) {
            if (Math.abs(freqRatio - harmonic) < this.harmonicConfig.harmonicTolerance * harmonic &&
                fundamental.magnitude > this.harmonicConfig.harmonicSuppressionFactor * peak.magnitude) {
              isHarmonic = true;
              break;
            }
          }
          if (isHarmonic) break;
        }
        if (!isHarmonic) confirmedPeaks.push(peak);
      }

      // Note tracking with pitch continuity
      activeNotes.forEach((entry) => entry.framesSinceLastSeen += 1);
      const currentMidis = new Set();
      confirmedPeaks.forEach(peak => {
        const midi = Math.round(this.minMidi + peak.bin);
        currentMidis.add(midi);

        if (activeNotes.has(midi)) {
          const entry = activeNotes.get(midi);
          entry.framesSinceLastSeen = 0;
          if (peak.magnitude > entry.note.magnitude) entry.note.magnitude = peak.magnitude;
        } else {
          // Check for pitch continuity
          const recentNotes = this.notes.filter(n => Math.abs(n.midi - midi) <= 1 &&
            (idx - n.startFrame) * timePerFrame < this.trackingConfig.maxGapTime);
          if (recentNotes.length > 0 &&
              idx - recentNotes[0].startFrame - recentNotes[0].duration / timePerFrame < this.trackingConfig.maxGapFrames) {
            const lastNote = recentNotes[0];
            lastNote.duration = (idx - lastNote.startFrame) * timePerFrame;
            activeNotes.set(midi, { note: lastNote, framesSinceLastSeen: 0 });
          } else {
            const newNote = {
              midi,
              frequency: 440 * Math.pow(2, (midi - 69) / 12),
              note: this.midiToNote(midi),
              time: isOnset ? idx * timePerFrame : (idx - 1) * timePerFrame,
              startFrame: idx,
              magnitude: peak.magnitude
            };
            activeNotes.set(midi, { note: newNote, framesSinceLastSeen: 0 });
          }
        }
      });

      // Terminate inactive notes
      activeNotes.forEach((entry, midi) => {
        if (entry.framesSinceLastSeen > this.trackingConfig.maxGapFrames) {
          const duration = (idx - entry.note.startFrame - entry.framesSinceLastSeen) * timePerFrame;
          if (duration >= this.trackingConfig.minNoteDuration) {
            entry.note.duration = duration;
            this.notes.push(entry.note);
          }
          activeNotes.delete(midi);
        }
      });
    });

    // Handle remaining active notes
    activeNotes.forEach((entry, midi) => {
      const duration = (this.cqtFrames.length - entry.note.startFrame - entry.framesSinceLastSeen) * timePerFrame;
      if (duration >= this.trackingConfig.minNoteDuration) {
        entry.note.duration = duration;
        this.notes.push(entry.note);
      }
    });

    // Post-process: Merge close notes
    this.notes = this.mergeCloseNotes(this.notes, timePerFrame);

    // Generate optimized guitar tab
    this.generateGuitarTab();
    return { notes: this.notes, guitarTab: this.guitarTab };
  }

  // Helper: Calculate spectral flatness
  calculateSpectralFlatness(magnitude) {
    const geometricMean = Math.exp(magnitude.reduce((sum, val) => sum + Math.log(val + 1e-10), 0) / magnitude.length);
    const arithmeticMean = magnitude.reduce((sum, val) => sum + val, 0) / magnitude.length;
    return geometricMean / arithmeticMean;
  }

  // Helper: Merge close notes
  mergeCloseNotes(notes, timePerFrame) {
    const merged = [];
    notes.sort((a, b) => a.time - b.time);
    let current = null;
    for (const note of notes) {
      if (!current) {
        current = { ...note };
      } else if (note.midi === current.midi &&
                 note.time < current.time + current.duration + this.trackingConfig.maxGapTime) {
        current.duration = Math.max(current.duration, (note.startFrame - current.startFrame) * timePerFrame + note.duration);
        current.magnitude = Math.max(current.magnitude, note.magnitude);
      } else {
        merged.push(current);
        current = { ...note };
      }
    }
    if (current) merged.push(current);
    return merged;
  }

  // Optimized guitar tab generation
  generateGuitarTab() {
    const timeBins = Math.ceil(this.duration / (this.hopSize / this.sampleRate));
    this.guitarTab = Array.from({ length: this.stringMidi.length }, () => new Array(timeBins).fill('-'));
    const lastPlayedFret = new Array(this.stringMidi.length).fill(null);

    this.notes.forEach(note => {
      const positions = this.noteToTab(note.note);
      if (positions.length) {
        const startBin = Math.floor(note.time / (this.hopSize / this.sampleRate));
        const endBin = Math.ceil((note.time + note.duration) / (this.hopSize / this.sampleRate));

        // Find the best position (lowest fret, favoring open strings or continuity)
        let bestPos = null;
        let minFretDiff = Infinity;
        for (const pos of positions) {
          const fretDiff = lastPlayedFret[pos.string - 1] !== null
            ? Math.abs(pos.fret - lastPlayedFret[pos.string - 1])
            : pos.fret;
          if (this.guitarTab[pos.string - 1][startBin] === '-' && fretDiff < minFretDiff) {
            bestPos = pos;
            minFretDiff = fretDiff;
          }
        }

        if (bestPos) {
          this.guitarTab[bestPos.string - 1][startBin] = bestPos.fret.toString();
          for (let bin = startBin + 1; bin < endBin && bin < timeBins; bin++) {
            if (this.guitarTab[bestPos.string - 1][bin] === '-') {
              this.guitarTab[bestPos.string - 1][bin] = '-';
            }
          }
          lastPlayedFret[bestPos.string - 1] = bestPos.fret;
        }
      }
    });
  }

  midiToNote(midi) {
    const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    return notes[midi % 12] + (Math.floor(midi / 12) - 1);
  }

  noteToTab(note) {
    const midi = this.noteToMidi(note);
    return this.stringMidi.map((stringMidi, i) => {
      const fret = midi - stringMidi;
      return fret >= 0 && fret <= this.maxFret ? { string: i + 1, fret } : null;
    }).filter(Boolean).sort((a, b) => a.fret - b.fret);
  }

  noteToMidi(note) {
    const match = note.match(/^([A-G]#?)(\d+)$/);
    if (!match) return 40;
    const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    return notes.indexOf(match[1]) + (parseInt(match[2]) + 1) * 12;
  }
}