export default class GuitarNoteDetector {
  constructor(
    sampleRate,
    fftSize,
    hopSize,
    fftInstance,
    cqtBinsPerOctave,
    cqtOctaves,
    minMidi = 40, // E2
    config = {}
  ) {
    if (!fftInstance || typeof fftInstance.cqt !== 'function') {
      throw new Error("A valid FFT instance with a .cqt() method must be provided.");
    }

    // Core parameters
    this.sampleRate = sampleRate;
    this.fftSize = fftSize;
    this.hopSize = hopSize;
    this.fftInstance = fftInstance;
    this.cqtBinsPerOctave = cqtBinsPerOctave;
    this.cqtOctaves = cqtOctaves;
    this.minMidi = minMidi;
    this.cqtTotalBins = cqtBinsPerOctave * cqtOctaves;

    // Merge configuration with defaults
    this.config = {
      // Detection parameters
      absoluteThreshold: 0.005,
      adaptiveThresholdFactor: 1.2,
      adaptiveWindowSize: 20, // frames
      peakProminenceFactor: 1.5,

      // Harmonic analysis
      maxHarmonics: 8,
      harmonicDecayFactor: 0.8,
      harmonicToleranceCents: 30,
      fundamentalBoost: 2.0,

      // Note tracking
      maxNoteDuration: 10.0, // seconds
      minNoteDuration: 0.05, // seconds
      pitchSmoothingFrames: 3,
      vibratoThresholdCents: 20,
      bendThresholdCents: 50,

      // Tab generation
      stringTuning: [40, 45, 50, 55, 59, 64], // E2, A2, D3, G3, B3, E4
      maxFret: 24,
      capoFret: 0,
      preferredPositionRange: [0, 12], // Fret range preference
      ...config
    };

    // Derived parameters
    this.timePerFrame = this.hopSize / this.sampleRate;
    this.minCqtFreq = 440 * Math.pow(2, (this.minMidi - 69) / 12);

    // Initialize state
    this.reset();

    // Pre-compute frequency bins
    this._computeFrequencyBins();

    // Initialize window function
    this.window = new Float32Array(this.fftSize);
    for (let i = 0; i < this.fftSize; i++) {
      this.window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (this.fftSize - 1));
    }
  }

  reset() {
    this.cqtFrames = [];
    this.notes = [];
    this.guitarTab = [];
    this.chords = [];
    this.confidenceMap = new Float32Array(0);
    this.duration = 0;
    this.spectralFlux = [];
    this.peakHistory = [];
  }

  async init() {
    // Initialize CQT if the FFT instance supports it
    if (typeof this.fftInstance.initCQT === 'function') {
      await this.fftInstance.initCQT(
        this.cqtBinsPerOctave,
        this.cqtOctaves,
        this.sampleRate,
        this.minCqtFreq
      );
    }
  }

  _computeFrequencyBins() {
    this.binFrequencies = new Float32Array(this.cqtTotalBins);
    this.binMidiNumbers = new Float32Array(this.cqtTotalBins);

    for (let i = 0; i < this.cqtTotalBins; i++) {
      this.binFrequencies[i] = this.minCqtFreq * Math.pow(2, i / this.cqtBinsPerOctave);
      this.binMidiNumbers[i] = this.minMidi + i / this.cqtBinsPerOctave;
    }
  }

  /**
   * Process audio buffer and compute CQT frames
   */
  processAudio(audioBuffer) {
    this.reset();
    this.duration = audioBuffer.length / this.sampleRate;

    const numFrames = Math.floor((audioBuffer.length - this.fftSize) / this.hopSize) + 1;

    // Process each frame
    for (let frame = 0; frame < numFrames; frame++) {
      const offset = frame * this.hopSize;
      const segment = audioBuffer.subarray(offset, offset + this.fftSize);

      // Apply window
      const windowed = new Float32Array(this.fftSize);
      for (let i = 0; i < this.fftSize; i++) {
        windowed[i] = segment[i] * this.window[i];
      }

      // Compute CQT
      const cqtResult = this.fftInstance.cqt(windowed);

      // Convert to magnitude spectrum
      const magnitude = new Float32Array(this.cqtTotalBins);
      for (let i = 0; i < this.cqtTotalBins; i++) {
        const real = cqtResult.real[i] || 0;
        const imag = cqtResult.imag[i] || 0;
        magnitude[i] = Math.sqrt(real * real + imag * imag);
      }

      this.cqtFrames.push(magnitude);
    }

    // Compute spectral flux for onset detection
    this._computeSpectralFlux();

    // Compute adaptive threshold
    this.computeAdaptiveThreshold();
  }

  /**
   * Compute spectral flux for onset detection
   */
  _computeSpectralFlux() {
    this.spectralFlux = new Float32Array(this.cqtFrames.length);

    for (let i = 1; i < this.cqtFrames.length; i++) {
      let flux = 0;
      const current = this.cqtFrames[i];
      const previous = this.cqtFrames[i - 1];

      for (let j = 0; j < this.cqtTotalBins; j++) {
        const diff = current[j] - previous[j];
        if (diff > 0) {
          flux += diff;
        }
      }

      this.spectralFlux[i] = flux;
    }
  }

  /**
   * Compute adaptive threshold for each frame
   */
  computeAdaptiveThreshold() {
    this.adaptiveThreshold = new Float32Array(this.cqtFrames.length);
    const windowSize = this.config.adaptiveWindowSize;

    for (let i = 0; i < this.cqtFrames.length; i++) {
      // Get local window
      const start = Math.max(0, i - windowSize);
      const end = Math.min(this.cqtFrames.length, i + windowSize);

      // Compute local statistics
      let sum = 0;
      let count = 0;

      for (let j = start; j < end; j++) {
        const frame = this.cqtFrames[j];
        for (let k = 0; k < this.cqtTotalBins; k++) {
          sum += frame[k];
          count++;
        }
      }

      const mean = sum / count;
      this.adaptiveThreshold[i] = Math.max(
        this.config.absoluteThreshold,
        mean * this.config.adaptiveThresholdFactor
      );
    }
  }

  /**
   * Detect notes using improved algorithm
   */
  detectNotes() {
    this.notes = [];
    const activeNotes = new Map(); // bin -> note object

    // Process each frame
    for (let frameIdx = 0; frameIdx < this.cqtFrames.length; frameIdx++) {
      const frame = this.cqtFrames[frameIdx];
      const time = frameIdx * this.timePerFrame;
      const threshold = this.adaptiveThreshold[frameIdx];

      // Find peaks in this frame
      const peaks = this._findPeaks(frame, threshold);

      // Perform harmonic analysis to identify fundamentals
      const fundamentals = this._identifyFundamentals(peaks, frame, threshold);

      // Update active notes
      this._updateActiveNotes(activeNotes, fundamentals, frameIdx, time);
    }

    // Finalize remaining active notes
    for (const note of activeNotes.values()) {
      this._finalizeNote(note);
    }

    // Post-process notes
    this._postProcessNotes();

    // Detect chords
    this._detectChords();

    // Generate guitar tab
    this._generateGuitarTab();

    return {
      notes: this.notes,
      chords: this.chords,
      guitarTab: this.guitarTab,
      confidenceMap: this.confidenceMap
    };
  }

  /**
   * Find spectral peaks with parabolic interpolation
   */
  _findPeaks(magnitude, threshold) {
    const peaks = [];

    for (let i = 1; i < this.cqtTotalBins - 1; i++) {
      const prev = magnitude[i - 1];
      const curr = magnitude[i];
      const next = magnitude[i + 1];

      // Check if this is a peak
      if (curr > prev && curr > next && curr > threshold) {
        // Parabolic interpolation for precise peak location
        const denom = prev - 2 * curr + next;
        if (Math.abs(denom) > 1e-10) {
          const p = 0.5 * (prev - next) / denom;
          const interpolatedBin = i + p;
          const interpolatedMag = curr - 0.25 * (prev - next) * p;

          peaks.push({
            bin: interpolatedBin,
            magnitude: interpolatedMag,
            frequency: this._binToFreq(interpolatedBin),
            midi: this._binToMidi(interpolatedBin)
          });
        }
      }
    }

    return peaks;
  }

  /**
   * Identify fundamental frequencies using harmonic analysis
   */
  _identifyFundamentals(peaks, magnitude, threshold) {
    if (peaks.length === 0) return [];

    const fundamentals = [];
    const used = new Set();

    // Sort peaks by magnitude (strongest first)
    peaks.sort((a, b) => b.magnitude - a.magnitude);

    for (const peak of peaks) {
      if (used.has(peak)) continue;

      // Calculate harmonic support score
      let harmonicScore = peak.magnitude;
      let harmonicCount = 1;
      const harmonics = [peak];

      // Check for harmonics
      for (let h = 2; h <= this.config.maxHarmonics; h++) {
        const expectedFreq = peak.frequency * h;
        const expectedBin = this._freqToBin(expectedFreq);

        // Look for harmonic peak within tolerance
        const toleranceBins = this.config.harmonicToleranceCents * this.cqtBinsPerOctave / 1200;

        for (const candidate of peaks) {
          if (used.has(candidate)) continue;

          const binDiff = Math.abs(candidate.bin - expectedBin);
          if (binDiff <= toleranceBins) {
            // Found harmonic
            const weight = Math.pow(this.config.harmonicDecayFactor, h - 1);
            harmonicScore += candidate.magnitude * weight;
            harmonicCount++;
            harmonics.push(candidate);
            break;
          }
        }
      }

      // Check if this is likely a fundamental
      // Lower the requirement - either has harmonics OR is strong enough
      if (harmonicCount >= 1 || peak.magnitude > threshold * 1.2) {
        fundamentals.push({
          ...peak,
          harmonicScore: harmonicScore * this.config.fundamentalBoost,
          harmonicCount: harmonicCount,
          harmonics: harmonics
        });

        // Mark harmonics as used to prevent double detection
        harmonics.forEach(h => used.add(h));
      }
    }

    return fundamentals;
  }

  /**
   * Update active notes with new fundamental detections
   */
  _updateActiveNotes(activeNotes, fundamentals, frameIdx, time) {
    const tolerance = 50; // cents
    const toleranceBins = tolerance * this.cqtBinsPerOctave / 1200;

    // Mark all active notes as not updated
    for (const note of activeNotes.values()) {
      note.updated = false;
    }

    // Match fundamentals to active notes
    for (const fundamental of fundamentals) {
      let matched = false;

      // Look for matching active note
      for (const [bin, note] of activeNotes) {
        if (Math.abs(fundamental.bin - bin) <= toleranceBins) {
          // Update existing note
          note.frames.push({
            time: time,
            frameIdx: frameIdx,
            frequency: fundamental.frequency,
            magnitude: fundamental.magnitude,
            midi: fundamental.midi
          });
          note.updated = true;
          matched = true;
          break;
        }
      }

      // Create new note if no match
      if (!matched) {
        const note = {
          startTime: time,
          startFrame: frameIdx,
          bin: fundamental.bin,
          frames: [{
            time: time,
            frameIdx: frameIdx,
            frequency: fundamental.frequency,
            magnitude: fundamental.magnitude,
            midi: fundamental.midi
          }],
          updated: true
        };
        activeNotes.set(fundamental.bin, note);
      }
    }

    // End notes that weren't updated
    const toRemove = [];
    for (const [bin, note] of activeNotes) {
      if (!note.updated) {
        this._finalizeNote(note);
        toRemove.push(bin);
      }
    }

    toRemove.forEach(bin => activeNotes.delete(bin));
  }

  /**
   * Finalize a note and add it to the notes array
   */
  _finalizeNote(note) {
    if (note.frames.length === 0) return;

    const duration = note.frames[note.frames.length - 1].time - note.startTime;

    // Skip very short notes
    if (duration < this.config.minNoteDuration) return;

    // Analyze pitch trajectory
    const pitchAnalysis = this._analyzePitchTrajectory(note.frames);

    // Calculate confidence score
    const confidence = this._calculateNoteConfidence(note, pitchAnalysis);

    // Create note object
    const finalNote = {
      time: note.startTime,
      duration: duration,
      midi: pitchAnalysis.averageMidi,
      frequency: pitchAnalysis.averageFrequency,
      velocity: pitchAnalysis.averageMagnitude,
      pitchBend: pitchAnalysis.pitchBend,
      vibrato: pitchAnalysis.vibrato,
      frames: note.frames,
      confidence: confidence
    };

    this.notes.push(finalNote);
  }

  /**
   * Analyze pitch trajectory for bends and vibrato
   */
  _analyzePitchTrajectory(frames) {
    if (frames.length === 0) return null;

    // Smooth pitch trajectory
    const smoothedMidi = this._smoothPitchTrajectory(
      frames.map(f => f.midi),
      this.config.pitchSmoothingFrames
    );

    // Calculate statistics
    let sumMidi = 0;
    let sumFreq = 0;
    let sumMag = 0;
    let minMidi = Infinity;
    let maxMidi = -Infinity;

    for (let i = 0; i < frames.length; i++) {
      const midi = smoothedMidi[i];
      sumMidi += midi;
      sumFreq += frames[i].frequency;
      sumMag += frames[i].magnitude;
      minMidi = Math.min(minMidi, midi);
      maxMidi = Math.max(maxMidi, midi);
    }

    const averageMidi = sumMidi / frames.length;
    const averageFrequency = sumFreq / frames.length;
    const averageMagnitude = sumMag / frames.length;

    // Detect pitch bend
    const midiRange = maxMidi - minMidi;
    const midiRangeCents = midiRange * 100;

    let pitchBend = null;
    if (midiRangeCents > this.config.bendThresholdCents) {
      // Significant pitch change - likely a bend
      const startMidi = smoothedMidi[0];
      const endMidi = smoothedMidi[smoothedMidi.length - 1];
      const bendAmount = endMidi - startMidi;

      pitchBend = {
        type: bendAmount > 0 ? 'up' : 'down',
        startMidi: startMidi,
        endMidi: endMidi,
        amount: Math.abs(bendAmount),
        trajectory: smoothedMidi
      };
    }

    // Detect vibrato
    let vibrato = null;
    if (midiRangeCents > this.config.vibratoThresholdCents && !pitchBend) {
      // Calculate vibrato rate
      const peaks = this._findLocalExtrema(smoothedMidi);
      if (peaks.length >= 4) {
        const periods = [];
        for (let i = 2; i < peaks.length; i += 2) {
          const period = (peaks[i].index - peaks[i - 2].index) * this.timePerFrame;
          periods.push(period);
        }

        if (periods.length > 0) {
          const avgPeriod = periods.reduce((a, b) => a + b) / periods.length;
          const rate = 1 / avgPeriod;

          vibrato = {
            rate: rate,
            depth: midiRangeCents,
            trajectory: smoothedMidi
          };
        }
      }
    }

    return {
      averageMidi,
      averageFrequency,
      averageMagnitude,
      pitchBend,
      vibrato
    };
  }

  /**
   * Smooth pitch trajectory using moving average
   */
  _smoothPitchTrajectory(midiValues, windowSize) {
    const smoothed = new Float32Array(midiValues.length);
    const halfWindow = Math.floor(windowSize / 2);

    for (let i = 0; i < midiValues.length; i++) {
      let sum = 0;
      let count = 0;

      for (let j = Math.max(0, i - halfWindow); j <= Math.min(midiValues.length - 1, i + halfWindow); j++) {
        sum += midiValues[j];
        count++;
      }

      smoothed[i] = sum / count;
    }

    return smoothed;
  }

  /**
   * Calculate confidence score for a detected note
   */
  _calculateNoteConfidence(note, pitchAnalysis) {
    let confidence = 1.0;

    // Factor 1: Note duration (longer notes are more confident)
    const durationScore = Math.min(1.0, note.frames.length / 10);
    confidence *= (0.5 + 0.5 * durationScore);

    // Factor 2: Pitch stability (less variation = higher confidence)
    const pitchVariation = this._calculatePitchVariation(note.frames);
    const stabilityScore = Math.exp(-pitchVariation * 2);
    confidence *= (0.7 + 0.3 * stabilityScore);

    // Factor 3: Signal strength (higher magnitude = higher confidence)
    const avgMagnitude = pitchAnalysis.averageMagnitude;
    const magnitudeScore = Math.min(1.0, avgMagnitude * 10);
    confidence *= (0.6 + 0.4 * magnitudeScore);

    // Factor 4: Harmonic clarity (check for clear harmonics)
    const harmonicScore = this._calculateHarmonicClarity(note.frames);
    confidence *= (0.8 + 0.2 * harmonicScore);

    // Factor 5: Onset clarity (sharp attack = higher confidence)
    if (note.frames.length > 2) {
      const onsetRatio = note.frames[1].magnitude / note.frames[0].magnitude;
      const onsetScore = Math.min(1.0, onsetRatio);
      confidence *= (0.9 + 0.1 * onsetScore);
    }

    return Math.min(1.0, Math.max(0.0, confidence));
  }

  /**
   * Calculate pitch variation in cents
   */
  _calculatePitchVariation(frames) {
    if (frames.length < 2) return 0;

    let totalVariation = 0;
    let count = 0;

    for (let i = 1; i < frames.length; i++) {
      const centsDiff = Math.abs(1200 * Math.log2(frames[i].frequency / frames[i-1].frequency));
      if (centsDiff < 100) { // Ignore large jumps
        totalVariation += centsDiff;
        count++;
      }
    }

    return count > 0 ? totalVariation / count : 0;
  }

  /**
   * Calculate harmonic clarity score
   */
  _calculateHarmonicClarity(frames) {
    // Simple implementation - could be enhanced with spectral analysis
    let totalClarity = 0;

    for (const frame of frames) {
      // Higher magnitude generally indicates clearer harmonics
      const clarity = Math.min(1.0, frame.magnitude * 5);
      totalClarity += clarity;
    }

    return totalClarity / frames.length;
  }

  /**
   * Find local extrema in an array
   */
  _findLocalExtrema(values) {
    const extrema = [];

    for (let i = 1; i < values.length - 1; i++) {
      if (values[i] > values[i - 1] && values[i] > values[i + 1]) {
        extrema.push({ index: i, value: values[i], type: 'max' });
      } else if (values[i] < values[i - 1] && values[i] < values[i + 1]) {
        extrema.push({ index: i, value: values[i], type: 'min' });
      }
    }

    return extrema;
  }

  /**
   * Post-process notes to clean up and merge
   */
  _postProcessNotes() {
    // Sort notes by time
    this.notes.sort((a, b) => a.time - b.time);

    // Merge very close notes
    const merged = [];
    let i = 0;

    while (i < this.notes.length) {
      const note = this.notes[i];
      const mergeWindow = 0.05; // 50ms

      // Look for notes to merge
      let j = i + 1;
      while (j < this.notes.length && this.notes[j].time - note.time < mergeWindow) {
        const otherNote = this.notes[j];

        // Check if notes are close in pitch
        if (Math.abs(note.midi - otherNote.midi) < 1) {
          // Merge notes
          note.duration = Math.max(note.duration, otherNote.time + otherNote.duration - note.time);
          note.velocity = Math.max(note.velocity, otherNote.velocity);
          j++;
        } else {
          break;
        }
      }

      merged.push(note);
      i = j;
    }

    this.notes = merged;
  }

  /**
   * Detect chords from notes
   */
  _detectChords() {
    this.chords = [];
    const chordWindow = 0.05; // 50ms

    // Group simultaneous notes
    let i = 0;
    while (i < this.notes.length) {
      const chordNotes = [this.notes[i]];
      let j = i + 1;

      // Find all notes starting within the window
      while (j < this.notes.length && this.notes[j].time - this.notes[i].time < chordWindow) {
        chordNotes.push(this.notes[j]);
        j++;
      }

      // Analyze chord if multiple notes
      if (chordNotes.length >= 2) {
        const chord = this._analyzeChord(chordNotes);
        if (chord) {
          this.chords.push(chord);
        }
      }

      i = j > i ? j : i + 1;
    }
  }

  /**
   * Analyze a group of notes to identify chord type
   */
  _analyzeChord(notes) {
    // Sort by pitch
    notes.sort((a, b) => a.midi - b.midi);

    // Get pitch classes
    const pitchClasses = notes.map(n => Math.round(n.midi) % 12);
    const uniquePitchClasses = [...new Set(pitchClasses)];

    if (uniquePitchClasses.length < 2) return null;

    // Find root and intervals
    const root = notes[0];
    const intervals = [];

    for (let i = 1; i < notes.length; i++) {
      const interval = Math.round(notes[i].midi - root.midi);
      if (!intervals.includes(interval)) {
        intervals.push(interval);
      }
    }

    // Identify chord type
    const chordType = this._identifyChordType(intervals);

    return {
      time: notes[0].time,
      duration: Math.max(...notes.map(n => n.duration)),
      root: root.midi,
      type: chordType,
      notes: notes.map(n => n.midi),
      inversion: 0 // Root position by default
    };
  }

  /**
   * Identify chord type from intervals
   */
  _identifyChordType(intervals) {
    const chordTypes = {
      'Major': [4, 7],
      'Minor': [3, 7],
      'Diminished': [3, 6],
      'Augmented': [4, 8],
      'Major 7': [4, 7, 11],
      'Minor 7': [3, 7, 10],
      'Dominant 7': [4, 7, 10],
      'Sus2': [2, 7],
      'Sus4': [5, 7],
      'Power': [7]
    };

    // Find best match
    let bestMatch = 'Unknown';
    let bestScore = 0;

    for (const [name, pattern] of Object.entries(chordTypes)) {
      let score = 0;
      for (const interval of pattern) {
        if (intervals.includes(interval)) {
          score++;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = name;
      }
    }

    return bestMatch;
  }

  /**
   * Generate guitar tablature
   */
  _generateGuitarTab() {
    const numStrings = this.config.stringTuning.length;
    const numColumns = Math.ceil(this.duration / this.timePerFrame);

    // Initialize tab array
    this.guitarTab = Array(numStrings).fill(null).map(() => Array(numColumns).fill('-'));

    // Initialize confidence array
    this.confidenceMap = new Float32Array(numColumns);

    // Process each note
    for (const note of this.notes) {
      const startColumn = Math.floor(note.time / this.timePerFrame);
      const endColumn = Math.floor((note.time + note.duration) / this.timePerFrame);

      // Bounds check
      if (startColumn < 0 || startColumn >= numColumns) continue;

      // Find best string/fret position
      const position = this._findBestPosition(note, startColumn, endColumn);

      if (position) {
        // Place note on tab
        this._placeNoteOnTab(note, position, startColumn, endColumn);
      }
    }
  }

  /**
   * Find best string/fret position for a note
   */
  _findBestPosition(note, startColumn, endColumn) {
    const midi = Math.round(note.midi);
    const positions = [];

    // Find all possible positions
    for (let string = 0; string < this.config.stringTuning.length; string++) {
      const openStringMidi = this.config.stringTuning[string] + this.config.capoFret;
      const fret = midi - openStringMidi;

      if (fret >= 0 && fret <= this.config.maxFret) {
        positions.push({ string, fret });
      }
    }

    if (positions.length === 0) return null;

    // Score each position
    let bestPosition = null;
    let bestScore = -Infinity;

    for (const pos of positions) {
      let score = 0;

      // Prefer positions in preferred range
      if (pos.fret >= this.config.preferredPositionRange[0] &&
          pos.fret <= this.config.preferredPositionRange[1]) {
        score += 10;
      }

      // Prefer open strings
      if (pos.fret === 0) {
        score += 5;
      }

      // Check if position is available
      let available = true;
      for (let col = startColumn; col <= endColumn && col < this.guitarTab[0].length; col++) {
        if (col >= 0 && this.guitarTab[pos.string][col] !== '-') {
          available = false;
          break;
        }
      }

      if (!available) {
        score -= 100;
      }

      // Consider context (nearby notes)
      score += this._scorePositionContext(pos, startColumn);

      if (score > bestScore) {
        bestScore = score;
        bestPosition = pos;
      }
    }

    return bestPosition;
  }

  /**
   * Score position based on context
   */
  _scorePositionContext(position, column) {
    let score = 0;
    const lookback = 10;
    const lookforward = 10;

    // Check nearby columns for hand position
    let totalFrets = 0;
    let fretCount = 0;

    for (let col = Math.max(0, column - lookback);
         col < Math.min(this.guitarTab[0].length, column + lookforward);
         col++) {
      for (let string = 0; string < this.guitarTab.length; string++) {
        const fret = this.guitarTab[string][col];
        if (fret !== '-' && fret !== '~') {
          const fretNum = parseInt(fret);
          if (!isNaN(fretNum)) {
            totalFrets += fretNum;
            fretCount++;
          }
        }
      }
    }

    if (fretCount > 0) {
      const avgFret = totalFrets / fretCount;
      const distance = Math.abs(position.fret - avgFret);
      score -= distance * 2;
    }

    return score;
  }

  /**
   * Place a note on the tab
   */
  _placeNoteOnTab(note, position, startColumn, endColumn) {
    const { string, fret } = position;

    // Place initial fret number
    let fretStr = fret.toString();

    // Add bend notation if needed
    if (note.pitchBend) {
      if (note.pitchBend.type === 'up') {
        if (note.pitchBend.amount >= 2) {
          fretStr += 'b'; // Full bend
        } else if (note.pitchBend.amount >= 1) {
          fretStr += 'h'; // Half bend
        }
      } else {
        fretStr += 'r'; // Release/pre-bend
      }
    }

    // Add vibrato notation
    if (note.vibrato && note.vibrato.rate > 3) {
      fretStr += '~';
    }

    // Place on tab with bounds check
    if (startColumn >= 0 && startColumn < this.guitarTab[string].length) {
      this.guitarTab[string][startColumn] = fretStr;

      // Store confidence
      if (this.confidenceMap && startColumn < this.confidenceMap.length) {
        this.confidenceMap[startColumn] = Math.max(
          this.confidenceMap[startColumn],
          note.confidence || 1.0
        );
      }
    }

    // Fill sustain
    for (let col = startColumn + 1; col <= endColumn && col < this.guitarTab[0].length; col++) {
      if (col >= 0 && col < this.guitarTab[string].length && this.guitarTab[string][col] === '-') {
        this.guitarTab[string][col] = '~';
        // Update confidence for sustained notes
        if (this.confidenceMap && col < this.confidenceMap.length) {
          this.confidenceMap[col] = Math.max(
            this.confidenceMap[col],
            note.confidence || 1.0
          );
        }
      } else {
        break; // Stop if we hit another note
      }
    }
  }

  // Utility methods
  _binToFreq(bin) {
    return this.minCqtFreq * Math.pow(2, bin / this.cqtBinsPerOctave);
  }

  _freqToBin(freq) {
    return this.cqtBinsPerOctave * Math.log2(freq / this.minCqtFreq);
  }

  _binToMidi(bin) {
    const freq = this._binToFreq(bin);
    return this._freqToMidi(freq);
  }

  _midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  _freqToMidi(freq) {
    return 69 + 12 * Math.log2(freq / 440);
  }

  /**
   * Process notes from existing CQT frames (for parameter updates)
   */
  processNotes() {
    if (!this.cqtFrames || this.cqtFrames.length === 0) {
      return { notes: [], guitarTab: [], chords: [] };
    }

    // Re-detect notes with current parameters
    return this.detectNotes();
  }
}