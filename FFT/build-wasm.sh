#!/bin/bash

emcc fft.cpp -O3 -msimd128 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORTED_FUNCTIONS='["_malloc","_free","_fft","_ifft","_initFFT","_freeFFT","_initCQT","_cqt","_freeCQT"]' \
  -o fft.js