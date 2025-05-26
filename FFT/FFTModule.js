import Module from './fft.js';

export default class FFT {
    constructor(size) {
        this.size = size;
        this.module = null;
        this.realPtr = null;
        this.imagPtr = null;
        this.cqtOutputRealPtr = null;
        this.cqtOutputImagPtr = null;
        this.memoryGeneration = 0;
        this._initialized = false;
        this._cqtInitialized = false;
    }

    async init() {
        if (!Number.isInteger(this.size) || this.size <= 0) {
            throw new Error("FFT size must be a positive integer.");
        }

        // Check if size is power of two
        if ((this.size & (this.size - 1)) !== 0) {
            throw new Error("FFT size must be a power of two.");
        }

        this.module = await Module();

        // Initialize FFT and check return value
        if (!this.module._initFFT(this.size)) {
            throw new Error("Failed to initialize FFT.");
        }

        this._allocateBuffers();
        this._initialized = true;
    }

    _allocateBuffers() {
        // Free existing buffers if any
        this._freeBuffers();

        this.realPtr = this.module._malloc(this.size * 4);
        this.imagPtr = this.module._malloc(this.size * 4);

        if (!this.realPtr || !this.imagPtr) {
            this._freeBuffers();
            throw new Error("Memory allocation failed.");
        }

        this._updateArrayViews();
    }

    _freeBuffers() {
        if (this.realPtr) {
            this.module._free(this.realPtr);
            this.realPtr = null;
        }
        if (this.imagPtr) {
            this.module._free(this.imagPtr);
            this.imagPtr = null;
        }
    }

    _updateArrayViews() {
        // Update array views and track memory generation
        this.memoryGeneration = this.module.HEAPF32.buffer.byteLength;
        this.real = new Float32Array(this.module.HEAPF32.buffer, this.realPtr, this.size);
        this.imag = new Float32Array(this.module.HEAPF32.buffer, this.imagPtr, this.size);

        if (this.cqtOutputRealPtr && this._cqtInitialized) {
            this.cqtOutputReal = new Float32Array(this.module.HEAPF32.buffer, this.cqtOutputRealPtr, this.cqtTotalBins);
            this.cqtOutputImag = new Float32Array(this.module.HEAPF32.buffer, this.cqtOutputImagPtr, this.cqtTotalBins);
        }
    }

    _checkMemoryResize() {
        if (this.module.HEAPF32.buffer.byteLength !== this.memoryGeneration) {
            this._updateArrayViews();
        }
    }

    /**
     * Resize the FFT to a new size
     * @param {number} newSize - New FFT size (must be power of two)
     */
    async resize(newSize) {
        if (!this._initialized) {
            throw new Error("FFT not initialized.");
        }

        if (!Number.isInteger(newSize) || newSize <= 0) {
            throw new Error("FFT size must be a positive integer.");
        }

        if ((newSize & (newSize - 1)) !== 0) {
            throw new Error("FFT size must be a power of two.");
        }

        if (newSize === this.size) {
            return; // No change needed
        }

        // Store CQT parameters if initialized
        let cqtParams = null;
        if (this._cqtInitialized) {
            cqtParams = {
                binsPerOctave: this.cqtBinsPerOctave,
                octaves: this.cqtOctaves,
                sampleRate: this.cqtSampleRate,
                minFreq: this.cqtMinFreq
            };
        }

        // Update size
        this.size = newSize;

        // Re-initialize FFT with new size
        if (!this.module._initFFT(this.size)) {
            throw new Error("Failed to resize FFT.");
        }

        // Reallocate buffers
        this._allocateBuffers();

        // Re-initialize CQT if it was previously initialized
        if (cqtParams) {
            await this.initCQT(
                cqtParams.binsPerOctave,
                cqtParams.octaves,
                cqtParams.sampleRate,
                cqtParams.minFreq
            );
        }
    }

    fft(inputReal, output = null) {
        if (!this.module || !this._initialized) {
            throw new Error("Module not initialized.");
        }
        if (!inputReal || inputReal.length !== this.size) {
            throw new Error("Input array must match FFT size.");
        }

        this._checkMemoryResize();

        this.real.set(inputReal);
        this.imag.fill(0);

        if (!this.module._fft(this.realPtr, this.imagPtr, this.size)) {
            throw new Error("FFT computation failed.");
        }

        if (output) {
            output.real.set(this.real);
            output.imag.set(this.imag);
            return output;
        }
        return { real: new Float32Array(this.real), imag: new Float32Array(this.imag) };
    }

    async initCQT(binsPerOctave, octaves, sampleRate, minFreq) {
        if (!this.module || !this._initialized) {
            throw new Error("Module not initialized.");
        }
        if (!Number.isInteger(binsPerOctave) || !Number.isInteger(octaves) ||
            binsPerOctave <= 0 || octaves <= 0 || sampleRate <= 0 || minFreq <= 0) {
            throw new Error("Invalid CQT parameters.");
        }

        // Store parameters
        this.cqtBinsPerOctave = binsPerOctave;
        this.cqtOctaves = octaves;
        this.cqtSampleRate = sampleRate;
        this.cqtMinFreq = minFreq;
        this.cqtTotalBins = binsPerOctave * octaves;

        if (!this.module._initCQT(binsPerOctave, octaves, this.size, sampleRate, minFreq)) {
            throw new Error("Failed to initialize CQT.");
        }

        // Free existing CQT memory if any
        if (this.cqtOutputRealPtr) this.module._free(this.cqtOutputRealPtr);
        if (this.cqtOutputImagPtr) this.module._free(this.cqtOutputImagPtr);

        this.cqtOutputRealPtr = this.module._malloc(this.cqtTotalBins * 4);
        this.cqtOutputImagPtr = this.module._malloc(this.cqtTotalBins * 4);
        if (!this.cqtOutputRealPtr || !this.cqtOutputImagPtr) {
            if (this.cqtOutputRealPtr) this.module._free(this.cqtOutputRealPtr);
            if (this.cqtOutputImagPtr) this.module._free(this.cqtOutputImagPtr);
            this.cqtOutputRealPtr = null;
            this.cqtOutputImagPtr = null;
            this._cqtInitialized = false;
            throw new Error("Memory allocation failed in initCQT.");
        }

        this._cqtInitialized = true;
        this._updateArrayViews();
    }

    cqt(inputReal, output = null) {
        if (!this.module || !this._initialized || !this._cqtInitialized) {
            throw new Error("CQT not initialized.");
        }
        if (!inputReal || inputReal.length !== this.size) {
            throw new Error("Input array must match FFT size.");
        }

        this._checkMemoryResize();

        // Compute FFT first
        this.real.set(inputReal);
        this.imag.fill(0);

        if (!this.module._fft(this.realPtr, this.imagPtr, this.size)) {
            throw new Error("FFT computation failed.");
        }

        if (!this.module._cqt(
            this.realPtr,
            this.imagPtr,
            this.cqtOutputRealPtr,
            this.cqtOutputImagPtr,
            this.size,
            this.cqtBinsPerOctave,
            this.cqtOctaves
        )) {
            throw new Error("CQT computation failed.");
        }

        if (output) {
            output.real.set(this.cqtOutputReal);
            output.imag.set(this.cqtOutputImag);
            return output;
        }
        return {
            real: new Float32Array(this.cqtOutputReal),
            imag: new Float32Array(this.cqtOutputImag)
        };
    }

    dispose() {
        if (this.module) {
            this._freeBuffers();
            if (this.cqtOutputRealPtr) this.module._free(this.cqtOutputRealPtr);
            if (this.cqtOutputImagPtr) this.module._free(this.cqtOutputImagPtr);
            this.module._freeFFT();
            this.module._freeCQT();
            this.module = null;
            this.realPtr = this.imagPtr = this.cqtOutputRealPtr = this.cqtOutputImagPtr = null;
            this.real = this.imag = this.cqtOutputReal = this.cqtOutputImag = null;
            this._initialized = false;
            this._cqtInitialized = false;
        }
    }
}
