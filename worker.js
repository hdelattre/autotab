import FFT from './FFT/FFTModule.js';
import GuitarNoteDetector from './GuitarNoteDetector.js';

let detector = null;

self.onmessage = async (e) => {
  const { audioBuffer, sampleRate, fftSize, hopSize, sensitivity, updateSensitivity } = e.data;

  // Handle sensitivity update without reprocessing the audio
  if (updateSensitivity && detector) {
    // Convert legacy sensitivity value to new thresholding config
    const thresholdConfig = {
      absoluteThreshold: 0.005,
      adaptiveThresholdFactor: sensitivity * 15, // Scale sensitivity to appropriate factor
      adaptiveReferencePercentile: 0.75
    };

    // Update thresholding configuration
    detector.thresholdConfig = { ...detector.thresholdConfig, ...thresholdConfig };

    // Re-detect notes from existing CQT frames (now doesn't take sensitivity parameter)
    const result = detector.detectNotes();
    self.postMessage({ guitarTab: result.guitarTab });
    return;
  }

  // Full processing for new audio data
  // Initialize FFT and CQT
  const fftInstance = new FFT(fftSize);
  await fftInstance.init();

  const minMidi = 40; // E2
  const cqtBinsPerOctave = 12; // One bin per semitone
  const cqtOctaves = 4; // Covers MIDI 40 to 87
  const minFreq = 440 * Math.pow(2, (minMidi - 69) / 12); // Frequency of E2
  await fftInstance.initCQT(cqtBinsPerOctave, cqtOctaves, sampleRate, minFreq);

  // Convert legacy sensitivity to new thresholding configuration
  const thresholdConfig = {
    absoluteThreshold: 0.005,
    adaptiveThresholdFactor: sensitivity * 15, // Scale sensitivity to appropriate factor
    adaptiveReferencePercentile: 0.75
  };

  // Process audio and detect notes with updated constructor signature
  const audioData = new Float32Array(audioBuffer);
  detector = new GuitarNoteDetector(
    sampleRate,
    fftSize,
    hopSize,
    fftInstance,
    cqtBinsPerOctave,
    cqtOctaves,
    minMidi,
    thresholdConfig, // New thresholding configuration
    {}, // Default harmonic config
    {}, // Default tracking config
    {}  // Default tab config
  );

  await detector.init();

  detector.computeCQTFrames(audioData);
  const result = detector.detectNotes();

  // Send results back to main thread
  self.postMessage({ guitarTab: result.guitarTab });
};