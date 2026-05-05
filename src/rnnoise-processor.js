// AudioWorklet processor that applies RNNoise neural-network noise suppression.
// RNNoise requires exactly 480 float32 samples per frame at 48 kHz (10 ms).
// The Web Audio API delivers 128 samples per process() call, so we accumulate
// into a 480-sample ring buffer, run the model, then drain from an output ring.

import createRNNWasmModuleSync from "./rnnoise-sync.js";

const FRAME = 480;

// Load WASM once per worklet global scope (shared across all processor nodes).
let wasmModule = null;
const wasmReady = createRNNWasmModuleSync().then((m) => {
  m._rnnoise_init();
  wasmModule = m;
});

class RNNoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.state = null;
    this.bufPtr = 0;
    this.inBuf = new Float32Array(FRAME);
    this.inIdx = 0;
    this.outBuf = new Float32Array(FRAME);
    this.outIdx = FRAME; // output ring empty until first frame is processed

    wasmReady.then(() => {
      this.state = wasmModule._rnnoise_create(0);
      // Allocate a 480-float32 scratch buffer in WASM heap (4 bytes each).
      this.bufPtr = wasmModule._malloc(FRAME * 4);
    });
  }

  process(inputs, outputs) {
    const inCh = inputs[0]?.[0];
    const outCh = outputs[0]?.[0];
    if (!outCh) return true;

    // Pass-through until WASM is ready.
    if (!this.state || !inCh) {
      if (inCh) outCh.set(inCh);
      return true;
    }

    const HEAPF32 = wasmModule.HEAPF32;
    const ptr32 = this.bufPtr >> 2; // byte ptr → Float32Array index

    for (let i = 0; i < inCh.length; i++) {
      // RNNoise works on int16-scaled floats (not normalised ±1).
      this.inBuf[this.inIdx++] = inCh[i] * 32768;

      if (this.inIdx === FRAME) {
        // Write to WASM heap, denoise in-place, read back.
        HEAPF32.set(this.inBuf, ptr32);
        wasmModule._rnnoise_process_frame(this.state, this.bufPtr, this.bufPtr);
        for (let j = 0; j < FRAME; j++) {
          this.outBuf[j] = HEAPF32[ptr32 + j] / 32768;
        }
        this.inIdx = 0;
        this.outIdx = 0;
      }

      outCh[i] = this.outIdx < FRAME ? this.outBuf[this.outIdx++] : 0;
    }

    return true;
  }
}

registerProcessor("rnnoise-processor", RNNoiseProcessor);
