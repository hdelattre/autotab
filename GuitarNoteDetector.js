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
      ...trackingConfig
    };

    // Tab generation parameters
    this.tabConfig = {
      stringMidi: [40, 45, 50, 55, 59, 64],
      maxFret: 24,
      ...tabConfig
    };

    // Set direct access properties for frequently used values
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

    this.cqtFrames.forEach((magnitude, idx) => {
      // Adaptive thresholding
      const sortedMagnitudes = [...magnitude].sort((a, b) => a - b);
      const referenceIndex = Math.floor(sortedMagnitudes.length * this.thresholdConfig.adaptiveReferencePercentile);
      const referenceMagnitude = referenceIndex < sortedMagnitudes.length ?
        sortedMagnitudes[referenceIndex] : 0;

      const adaptiveComponent = this.thresholdConfig.adaptiveThresholdFactor * referenceMagnitude;
      const threshold = Math.max(this.thresholdConfig.absoluteThreshold, adaptiveComponent);

      // Refined peak picking with interpolation
      const potentialPeaks = [];
      for (let k = 1; k < this.cqtTotalBins - 1; k++) {
        if (magnitude[k] > magnitude[k - 1] && magnitude[k] > magnitude[k + 1] && magnitude[k] > threshold) {
          // Quadratic peak interpolation
          const y_minus = magnitude[k - 1];
          const y_0 = magnitude[k];
          const y_plus = magnitude[k + 1];

          // Calculate interpolation offset
          const denominator = y_minus - 2 * y_0 + y_plus;
          const p = Math.abs(denominator) > 1e-6 ?
            0.5 * (y_minus - y_plus) / denominator : 0;

          // Calculate interpolated bin and magnitude
          const interpolatedBin = k + p;
          const interpolatedMagnitude = y_0 - 0.25 * (y_minus - y_plus) * p;

          potentialPeaks.push({ bin: interpolatedBin, magnitude: interpolatedMagnitude });
        }
      }

      // Apply harmonic filtering
      const sortedPeaks = [...potentialPeaks].sort((a, b) => a.bin - b.bin);
      const confirmedPeaks = [];

      for (const peak of sortedPeaks) {
        let isHarmonic = false;

        // Check if this peak is a harmonic of any already confirmed peak
        for (const fundamental of confirmedPeaks) {
          if (fundamental.bin <= 0) continue;

          const freqRatio = peak.bin / fundamental.bin;
          const nearestInteger = Math.round(freqRatio);

          if (nearestInteger >= 2 &&
              Math.abs(freqRatio - nearestInteger) / nearestInteger < this.harmonicConfig.harmonicTolerance &&
              fundamental.magnitude > this.harmonicConfig.harmonicSuppressionFactor * peak.magnitude) {
            isHarmonic = true;
            break;
          }
        }

        if (!isHarmonic) {
          confirmedPeaks.push(peak);
        }
      }

      // Improved note tracking with gap closing
      // Increment counter for all active notes
      activeNotes.forEach((entry) => {
        entry.framesSinceLastSeen += 1;
      });

      // Process confirmed peaks
      const currentMidis = new Set();

      confirmedPeaks.forEach(peak => {
        const midi = Math.round(this.minMidi + peak.bin);
        currentMidis.add(midi);

        if (activeNotes.has(midi)) {
          // Reset the counter for existing notes
          activeNotes.get(midi).framesSinceLastSeen = 0;
          // Optionally update magnitude if current is higher
          if (peak.magnitude > activeNotes.get(midi).note.magnitude) {
            activeNotes.get(midi).note.magnitude = peak.magnitude;
          }
        } else {
          // Create a new note
          const newNote = {
            midi,
            frequency: 440 * Math.pow(2, (midi - 69) / 12),
            note: this.midiToNote(midi),
            time: idx * timePerFrame,
            startFrame: idx,
            magnitude: peak.magnitude
          };

          // Add to active notes with counter
          activeNotes.set(midi, {
            note: newNote,
            framesSinceLastSeen: 0
          });
        }
      });

      // Terminate notes that exceeded the gap tolerance
      activeNotes.forEach((entry, midi) => {
        if (entry.framesSinceLastSeen > this.trackingConfig.maxGapFrames) {
          // Calculate duration excluding the gap
          const duration = (idx - entry.note.startFrame - entry.framesSinceLastSeen) * timePerFrame;

          if (duration >= this.trackingConfig.minNoteDuration) {
            entry.note.duration = duration;
            this.notes.push(entry.note);
          }

          activeNotes.delete(midi);
        }
      });
    });

    // Handle remaining active notes at the end of processing
    activeNotes.forEach((entry, midi) => {
      // Calculate duration excluding any trailing gap
      const duration = (this.cqtFrames.length - entry.note.startFrame - entry.framesSinceLastSeen) * timePerFrame;

      if (duration >= this.trackingConfig.minNoteDuration) {
        entry.note.duration = duration;
        this.notes.push(entry.note);
      }
    });

    this.generateGuitarTab();
    return { notes: this.notes, guitarTab: this.guitarTab };
  }

  generateGuitarTab() {
    const timeBins = Math.ceil(this.duration / (this.hopSize / this.sampleRate));
    this.guitarTab = Array.from({ length: this.stringMidi.length }, () => new Array(timeBins).fill('-'));

    // Track last played fret on each string for better heuristics
    const lastPlayedFret = new Array(this.stringMidi.length).fill(null);

    this.notes.forEach(note => {
      const positions = this.noteToTab(note.note);

      if (positions.length) {
        const startBin = Math.floor(note.time / (this.hopSize / this.sampleRate));
        const endBin = Math.ceil((note.time + note.duration) / (this.hopSize / this.sampleRate));

        // Try to find a free string at the start time
        for (const pos of positions) {
          if (this.guitarTab[pos.string - 1][startBin] === '-') {
            // Found a free string, assign the fret
            this.guitarTab[pos.string - 1][startBin] = pos.fret.toString();

            // Fill sustain markers
            for (let bin = startBin + 1; bin < endBin && bin < timeBins; bin++) {
              if (this.guitarTab[pos.string - 1][bin] === '-') {
                this.guitarTab[pos.string - 1][bin] = '-'; // Standard sustain marker
              }
            }

            // Update last played fret on this string
            lastPlayedFret[pos.string - 1] = pos.fret;

            // Found a place for this note, stop looking
            break;
          }
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