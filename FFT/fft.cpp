#include <math.h>
#include <stdlib.h>
#include <emscripten.h>
#include <vector>

static float* twiddleReal = nullptr;
static float* twiddleImag = nullptr;
static int* bitReversalIndices = nullptr;
static std::vector<std::vector<float>> cqtKernelReal, cqtKernelImag;

extern "C" {

// Helper function to check if n is a power of two
static inline bool isPowerOfTwo(int n) {
    return (n > 0) && ((n & (n - 1)) == 0);
}

EMSCRIPTEN_KEEPALIVE
bool initFFT(int n) {
    if (!isPowerOfTwo(n)) {
        return false;
    }
    twiddleReal = static_cast<float*>(malloc(n / 2 * sizeof(float)));
    twiddleImag = static_cast<float*>(malloc(n / 2 * sizeof(float)));
    if (!twiddleReal || !twiddleImag) {
        free(twiddleReal); free(twiddleImag);
        twiddleReal = nullptr; twiddleImag = nullptr;
        return false;
    }
    for (int i = 0; i < n / 2; i++) {
        float angle = -2.0f * M_PI * i / n;
        twiddleReal[i] = cosf(angle);
        twiddleImag[i] = sinf(angle);
    }
    bitReversalIndices = static_cast<int*>(malloc(n * sizeof(int)));
    if (!bitReversalIndices) {
        free(twiddleReal); free(twiddleImag);
        twiddleReal = nullptr; twiddleImag = nullptr;
        bitReversalIndices = nullptr;
        return false;
    }
    int j = 0;
    for (int i = 0; i < n; i++) {
        bitReversalIndices[i] = j;
        int bit = n >> 1;
        while (j & bit) { j ^= bit; bit >>= 1; }
        j ^= bit;
    }
    return true;
}

EMSCRIPTEN_KEEPALIVE
bool fft(float* real, float* imag, int n) {
    if (!isPowerOfTwo(n) || !real || !imag || !twiddleReal || !bitReversalIndices) {
        return false;
    }
    for (int i = 0; i < n; i++) {
        int j = bitReversalIndices[i];
        if (i < j) {
            std::swap(real[i], real[j]);
            std::swap(imag[i], imag[j]);
        }
    }
    for (int len = 2; len <= n; len <<= 1) {
        int half = len / 2, step = n / len;
        for (int i = 0; i < n; i += len) {
            for (int j = 0; j < half; j++) {
                int even = i + j, odd = even + half;
                float re = real[odd] * twiddleReal[j * step] - imag[odd] * twiddleImag[j * step];
                float im = real[odd] * twiddleImag[j * step] + imag[odd] * twiddleReal[j * step];
                real[odd] = real[even] - re;
                imag[odd] = imag[even] - im;
                real[even] += re;
                imag[even] += im;
            }
        }
    }
    return true;
}

EMSCRIPTEN_KEEPALIVE
bool ifft(float* real, float* imag, int n) {
    if (!isPowerOfTwo(n) || !real || !imag) {
        return false;
    }
    float invN = 1.0f / n;
    for (int i = 0; i < n; i++) imag[i] = -imag[i];
    if (!fft(real, imag, n)) {
        return false;
    }
    for (int i = 0; i < n; i++) {
        real[i] *= invN;
        imag[i] *= -invN;
    }
    return true;
}

EMSCRIPTEN_KEEPALIVE
bool initCQT(int binsPerOctave, int octaves, int n, float sampleRate, float minFreq) {
    if (binsPerOctave <= 0 || octaves <= 0 || n <= 0 || sampleRate <= 0 || minFreq <= 0) {
        return false;
    }
    int totalBins = binsPerOctave * octaves;
    cqtKernelReal.resize(totalBins, std::vector<float>(n, 0.0f));
    cqtKernelImag.resize(totalBins, std::vector<float>(n, 0.0f));
    float Q = 1.0f / (powf(2.0f, 1.0f / binsPerOctave) - 1.0f);
    for (int k = 0; k < totalBins; k++) {
        float freq = minFreq * powf(2.0f, static_cast<float>(k) / binsPerOctave);
        if (freq <= 0 || freq >= sampleRate / 2) continue;
        int filterLen = static_cast<int>(ceilf(Q * sampleRate / freq));
        if (filterLen > n) filterLen = n;
        if (filterLen <= 0) continue;
        std::vector<float> tempReal(n, 0.0f), tempImag(n, 0.0f);
        float invFilterLenMinus1 = 1.0f / (filterLen - 1);
        for (int i = 0; i < filterLen; i++) {
            float t = static_cast<float>(i) - (filterLen - 1.0f) / 2.0f;
            float window = 0.5f - 0.5f * cosf(2.0f * M_PI * i * invFilterLenMinus1);
            tempReal[i] = window * cosf(2.0f * M_PI * freq * t / sampleRate);
            tempImag[i] = window * sinf(2.0f * M_PI * freq * t / sampleRate);
        }
        if (!fft(tempReal.data(), tempImag.data(), n)) {
            return false;
        }
        for (int i = 0; i < n; i++) {
            cqtKernelReal[k][i] = tempReal[i];
            cqtKernelImag[k][i] = tempImag[i];
        }
    }
    return true;
}

EMSCRIPTEN_KEEPALIVE
bool cqt(float* inputReal, float* inputImag, float* outputReal, float* outputImag, int n, int binsPerOctave, int octaves) {
    if (!inputReal || !inputImag || !outputReal || !outputImag || binsPerOctave <= 0 || octaves <= 0 || n <= 0) {
        return false;
    }
    int totalBins = binsPerOctave * octaves;
    if (totalBins > static_cast<int>(cqtKernelReal.size())) {
        return false;
    }
    float invN = 1.0f / n;
    for (int k = 0; k < totalBins; k++) {
        float sumReal = 0.0f, sumImag = 0.0f;
        for (int i = 0; i < n; i++) {
            sumReal += inputReal[i] * cqtKernelReal[k][i] - inputImag[i] * cqtKernelImag[k][i];
            sumImag += inputReal[i] * cqtKernelImag[k][i] + inputImag[i] * cqtKernelReal[k][i];
        }
        outputReal[k] = sumReal * invN;
        outputImag[k] = sumImag * invN;
    }
    return true;
}

EMSCRIPTEN_KEEPALIVE
bool freeFFT() {
    if (twiddleReal) free(twiddleReal);
    if (twiddleImag) free(twiddleImag);
    if (bitReversalIndices) free(bitReversalIndices);
    twiddleReal = nullptr;
    twiddleImag = nullptr;
    bitReversalIndices = nullptr;
    return true; // Always succeeds since we don't care about failure here
}

EMSCRIPTEN_KEEPALIVE
bool freeCQT() {
    cqtKernelReal.clear();
    cqtKernelImag.clear();
    return true; // Always succeeds since clear() can't fail in this context
}

} // extern "C"