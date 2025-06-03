import WaveFFT from './WaveFFT/WaveFFT.js';
import GuitarNoteDetector from './GuitarNoteDetector.js';

let detector = null;
let fftInstance = null;

self.onmessage = async (e) => {
  const {
    audioBuffer,
    sampleRate,
    fftSize,
    hopSize,
    sensitivity,
    updateSensitivity,
    guitarConfig
  } = e.data;

  try {
    // Handle sensitivity update without reprocessing the audio
    if (updateSensitivity && detector) {
      // Convert legacy sensitivity value to new thresholding config
      const thresholdConfig = {
        absoluteThreshold: 0.001 + (0.009 * (1 - sensitivity)), // 0.01 at sensitivity 0, 0.001 at sensitivity 1
        adaptiveThresholdFactor: 0.5 + (sensitivity * 3) // Scale sensitivity: 0.0 -> 0.5, 1.0 -> 3.5
      };

      // Update thresholding configuration
      detector.config = { ...detector.config, ...thresholdConfig };

      // Re-compute adaptive threshold with new settings
      detector.computeAdaptiveThreshold();

      // Re-detect notes from existing CQT frames
      const result = detector.detectNotes();
      self.postMessage({
        guitarTab: result.guitarTab,
        notes: result.notes,
        chords: result.chords,
        confidenceMap: result.confidenceMap
      });
      return;
    }

    // Full processing for new audio data
    if (!audioBuffer || !sampleRate || !fftSize || !hopSize) {
      throw new Error("Missing required parameters");
    }

    // Clean up previous detector but keep FFT instance if possible
    if (detector) {
      detector = null;
    }

    // Only recreate FFT if not initialized
    if (!fftInstance) {
      // Initialize FFT
      fftInstance = new WaveFFT(fftSize);
      await fftInstance.init();
    } else if (fftInstance.size !== fftSize) {
      // Use resize method instead of recreating
      await fftInstance.resize(fftSize);
    }

    // Guitar-specific parameters (restored from working version)
    const minMidi = 40; // E2
    const cqtBinsPerOctave = 12; // One bin per semitone
    const cqtOctaves = 4; // Covers MIDI 40 to 87
    const minFreq = 440 * Math.pow(2, (minMidi - 69) / 12); // Frequency of E2

    // Initialize CQT
    await fftInstance.initCQT(cqtBinsPerOctave, cqtOctaves, sampleRate, minFreq);

    // Convert legacy sensitivity to new thresholding configuration
    const thresholdConfig = {
      absoluteThreshold: 0.001 + (0.009 * (1 - sensitivity)), // 0.01 at sensitivity 0, 0.001 at sensitivity 1
      adaptiveThresholdFactor: 0.5 + (sensitivity * 3) // Scale sensitivity: 0.0 -> 0.5, 1.0 -> 3.5
    };

    // Create configuration object
    const config = {
      // Use the old threshold configuration approach
      ...thresholdConfig,

      // Harmonic analysis settings
      maxHarmonics: guitarConfig?.maxHarmonics || 8,
      harmonicDecayFactor: guitarConfig?.harmonicDecayFactor || 0.8,
      harmonicToleranceCents: guitarConfig?.harmonicToleranceCents || 30,
      fundamentalBoost: guitarConfig?.fundamentalBoost || 2.0,

      // Note tracking settings
      maxNoteDuration: guitarConfig?.maxNoteDuration || 10.0,
      minNoteDuration: guitarConfig?.minNoteDuration || 0.05,
      pitchSmoothingFrames: guitarConfig?.pitchSmoothingFrames || 3,
      vibratoThresholdCents: guitarConfig?.vibratoThresholdCents || 20,
      bendThresholdCents: guitarConfig?.bendThresholdCents || 50,

      // Guitar-specific settings
      stringTuning: guitarConfig?.tuning || [40, 45, 50, 55, 59, 64],
      maxFret: guitarConfig?.maxFret || 24,
      capoFret: guitarConfig?.capo || 0,
      preferredPositionRange: guitarConfig?.preferredPosition || [0, 12]
    };

    // Create detector instance
    detector = new GuitarNoteDetector(
      sampleRate,
      fftSize,
      hopSize,
      fftInstance,
      cqtBinsPerOctave,
      cqtOctaves,
      minMidi,
      config
    );

    await detector.init();

    // Process audio
    const audioData = new Float32Array(audioBuffer);
    detector.processAudio(audioData);

    // Detect notes and generate tab
    const result = detector.detectNotes();

    // Send results back to main thread
    self.postMessage({
      guitarTab: result.guitarTab,
      notes: result.notes,
      chords: result.chords,
      confidenceMap: result.confidenceMap,
      config: {
        sampleRate,
        hopSize,
        fftSize,
        cqtBinsPerOctave,
        cqtOctaves
      }
    });

  } catch (error) {
    console.error('Worker error:', error);
    self.postMessage({
      error: error.message,
      guitarTab: Array(6).fill(null).map(() => [])
    });
  }
};

// Handle cleanup
self.addEventListener('unload', () => {
  if (fftInstance) {
    fftInstance.dispose();
    fftInstance = null;
  }
  if (detector) {
    detector = null;
  }
});
