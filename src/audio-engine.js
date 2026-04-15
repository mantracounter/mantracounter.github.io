const FRAME_MS = 50;

function rms(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    sum += buffer[i] * buffer[i];
  }
  return Math.sqrt(sum / Math.max(1, buffer.length));
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.source = null;
    this.preGain = null;
    this.compressor = null;
    this.rnnoiseNode = null;
    this.analyser = null;
    this.frameTimer = null;
    this.prevSpectrum = null;
    this.workletLoaded = false;

    this.noiseFloor = 0.01;
    this.fluxFloor = 0.01;

    // Tier-3: running short-term maximum energy (exponential decay ~2 s)
    this.shortTermMaxEnergy = 0;

    this.segment = null;
    this.silenceFrames = 0;

    // Live-updatable segment detection params
    this._hangoverFrames = Math.ceil(550 / FRAME_MS);
    this._minFrames = Math.ceil(150 / FRAME_MS);
    this._maxFrames = Math.ceil(8000 / FRAME_MS);

    // Pranayama timer state
    this._pranaTimer = null;
  }

  // ── Initialise Web Audio graph ─────────────────────────────────────────────
  // noiseCancellation: whether to insert the RNNoise AudioWorklet node.
  // Requesting 48 kHz matches RNNoise's required sample rate.
  async init({ noiseCancellation = false, deviceId = "" } = {}) {
    if (this.ctx) return;

    this._deviceId = deviceId;
    const audioConstraints = {
      echoCancellation: true,
      noiseSuppression: !noiseCancellation,
      autoGainControl: false,
    };
    if (deviceId) audioConstraints.deviceId = { exact: deviceId };

    this.stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    this.ctx = new AudioContext({ sampleRate: 48000 });
    this.source = this.ctx.createMediaStreamSource(this.stream);

    // Tier-1: +15 dB pre-gain + dynamics compressor to level quiet/distant voice.
    // Chain (without RNNoise): source → preGain → compressor → analyser
    // Chain (with RNNoise):   source → preGain → compressor → rnnoise → analyser
    this.preGain = this.ctx.createGain();
    this.preGain.gain.value = 6.0; // ×6 ≈ +15 dB

    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -24; // dBFS
    this.compressor.knee.value = 10;
    this.compressor.ratio.value = 8;
    this.compressor.attack.value = 0.005;  // 5 ms
    this.compressor.release.value = 0.25;  // 250 ms

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;

    this.source.connect(this.preGain);
    this.preGain.connect(this.compressor);

    if (noiseCancellation && typeof AudioWorkletNode !== "undefined") {
      try {
        // The processor imports rnnoise-sync.js as a relative sibling.
        if (!this.workletLoaded) {
          await this.ctx.audioWorklet.addModule("./src/rnnoise-processor.js");
          this.workletLoaded = true;
        }
        this.rnnoiseNode = new AudioWorkletNode(this.ctx, "rnnoise-processor");
        this.compressor.connect(this.rnnoiseNode);
        this.rnnoiseNode.connect(this.analyser);
      } catch (err) {
        console.warn("RNNoise AudioWorklet failed, falling back:", err);
        this.rnnoiseNode = null;
        this.compressor.connect(this.analyser);
      }
    } else {
      this.compressor.connect(this.analyser);
    }
  }

  stopAll() {
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
    this.stopPranayamaTimer();

    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
    }

    if (this.ctx) {
      this.ctx.close();
    }

    this.ctx = null;
    this.stream = null;
    this.source = null;
    this.preGain = null;
    this.compressor = null;
    this.rnnoiseNode = null;
    this.analyser = null;
    this.prevSpectrum = null;
    this.shortTermMaxEnergy = 0;
    this.segment = null;
    this.silenceFrames = 0;
  }

  // ── Frame measurement ──────────────────────────────────────────────────────

  getFrame() {
    const analyser = this.analyser;
    const time = new Float32Array(analyser.fftSize);
    const freq = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatTimeDomainData(time);
    analyser.getFloatFrequencyData(freq);

    const energy = rms(time);

    // Spectral flux: positive-only magnitude change from previous frame.
    // Voiced onsets have high flux; steady noise does not.
    const mags = new Float32Array(freq.length);
    for (let i = 0; i < freq.length; i += 1) {
      const db = Number.isFinite(freq[i]) ? freq[i] : -120;
      mags[i] = 10 ** (db / 20);
    }

    let fluxSum = 0;
    if (this.prevSpectrum) {
      for (let i = 0; i < mags.length; i += 1) {
        const diff = mags[i] - this.prevSpectrum[i];
        if (diff > 0) fluxSum += diff;
      }
    }
    const flux = fluxSum / Math.max(1, mags.length);
    this.prevSpectrum = mags;

    return { ts: performance.now(), energy, flux };
  }

  // ── Noise floor calibration ────────────────────────────────────────────────

  async calibrateNoise(sampleCount = 36) {
    const energies = [];
    const fluxes = [];
    for (let i = 0; i < sampleCount; i += 1) {
      const frame = this.getFrame();
      energies.push(frame.energy);
      fluxes.push(frame.flux);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    energies.sort((a, b) => a - b);
    fluxes.sort((a, b) => a - b);
    // 75th percentile: floor above the bulk of noise variance.
    const eIdx = Math.floor(energies.length * 0.75);
    const fIdx = Math.floor(fluxes.length * 0.75);
    this.noiseFloor = Math.max(energies[eIdx] || 0.01, 0.0015);
    this.fluxFloor = Math.max(fluxes[fIdx] || 0.005, 0.0003);
  }

  // ── Voice activity detection ───────────────────────────────────────────────

  isVoiced(frame) {
    // Tier-3: adaptive floor — when recent speech energy is well above noise,
    // use the geometric mean as the floor so a quiet mic can still trigger.
    const adaptiveFloor =
      this.shortTermMaxEnergy > this.noiseFloor * 4
        ? Math.sqrt(this.shortTermMaxEnergy * this.noiseFloor)
        : this.noiseFloor;

    const eThreshold = Math.max(adaptiveFloor * 1.6, 0.002);
    const fThreshold = Math.max(this.fluxFloor * 1.2, 0.0009);
    const energetic = frame.energy > eThreshold;
    const dynamic = frame.flux > fThreshold;
    const sustained = frame.energy > Math.max(adaptiveFloor * 2.2, 0.0045);
    return energetic && (dynamic || sustained);
  }

  // ── Segment stream ─────────────────────────────────────────────────────────
  //
  // mantraGapMs   – minimum silence (ms) separating two mantra repetitions;
  //                 sounds closer than this are joined into one segment.
  // minSegmentMs  – shortest sound that counts as a mantra (noise filter).
  // maxSegmentMs  – a segment longer than this is force-closed and emitted.

  // Swap microphone live without stopping the VAD loop.
  async setMicDevice(deviceId) {
    this._deviceId = deviceId;
    if (!this.ctx) return; // not running; will apply on next init

    const audioConstraints = {
      echoCancellation: true,
      noiseSuppression: this.rnnoiseNode == null,
      autoGainControl: false,
    };
    if (deviceId) audioConstraints.deviceId = { exact: deviceId };

    let newStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    } catch (err) {
      console.warn("setMicDevice failed:", err);
      return;
    }

    // Disconnect old source, connect new one
    try { this.source.disconnect(); } catch (_) {}
    this.stream.getTracks().forEach((t) => t.stop());

    this.stream = newStream;
    this.source = this.ctx.createMediaStreamSource(newStream);
    this.source.connect(this.preGain);
  }

  // Update detection params live (safe to call while stream is running).
  updateSegmentParams({ mantraGapMs, minSegmentMs, maxSegmentMs }) {
    this._hangoverFrames = Math.ceil(mantraGapMs / FRAME_MS);
    this._minFrames = Math.ceil(minSegmentMs / FRAME_MS);
    this._maxFrames = Math.ceil(maxSegmentMs / FRAME_MS);
  }

  // Toggle RNNoise live without stopping the stream.
  async setNoiseCancellation(enabled) {
    if (!this.ctx) return; // not running; will apply on next init

    // Tear down current downstream chain from compressor
    try { this.compressor.disconnect(); } catch (_) {}
    if (this.rnnoiseNode) {
      try { this.rnnoiseNode.disconnect(); } catch (_) {}
      this.rnnoiseNode = null;
    }

    if (enabled && typeof AudioWorkletNode !== "undefined") {
      try {
        if (!this.workletLoaded) {
          await this.ctx.audioWorklet.addModule("./src/rnnoise-processor.js");
          this.workletLoaded = true;
        }
        this.rnnoiseNode = new AudioWorkletNode(this.ctx, "rnnoise-processor");
        this.compressor.connect(this.rnnoiseNode);
        this.rnnoiseNode.connect(this.analyser);
      } catch (err) {
        console.warn("RNNoise live toggle failed, falling back:", err);
        this.rnnoiseNode = null;
        this.compressor.connect(this.analyser);
      }
    } else {
      this.compressor.connect(this.analyser);
    }
  }

  runSegmentStream({ onSegment, mantraGapMs = 550, minSegmentMs = 150, maxSegmentMs = 8000 }) {
    this.updateSegmentParams({ mantraGapMs, minSegmentMs, maxSegmentMs });

    this.segment = null;
    this.silenceFrames = 0;

    if (this.frameTimer) clearInterval(this.frameTimer);

    this.frameTimer = setInterval(() => {
      const frame = this.getFrame();

      // Tier-3: decay short-term max (~2 s time constant at 50 ms/frame)
      this.shortTermMaxEnergy = Math.max(frame.energy, this.shortTermMaxEnergy * 0.975);

      const voiced = this.isVoiced(frame);

      if (voiced) {
        if (!this.segment) {
          this.segment = { startedAt: frame.ts, voicedFrames: 0 };
        }
        this.segment.voicedFrames += 1;
        this.silenceFrames = 0;

        if (this.segment.voicedFrames >= this._maxFrames) {
          this._emitSegment(onSegment, this._minFrames);
        }
      } else if (this.segment) {
        this.silenceFrames += 1;
        if (this.silenceFrames > this._hangoverFrames) {
          this._emitSegment(onSegment, this._minFrames);
        }
      }
    }, FRAME_MS);
  }

  _emitSegment(onSegment, minFrames) {
    const seg = this.segment;
    this.segment = null;
    this.silenceFrames = 0;
    if (seg && seg.voicedFrames >= minFrames) {
      onSegment?.();
    }
  }

  stopSegmentStream() {
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
    this.segment = null;
    this.silenceFrames = 0;
  }

  // ── Bell playback ──────────────────────────────────────────────────────────
  // Plays the pre-decoded bell buffer at the given volume (0–1).
  // bellBuffer is loaded and cached externally (main.js loadBell()).
  playBell(bellBuffer, volume = 1.0) {
    if (!this.ctx || !bellBuffer) return;
    this.ctx.resume().then(() => {
      const gain = this.ctx.createGain();
      gain.gain.value = volume;
      gain.connect(this.ctx.destination);
      const src = this.ctx.createBufferSource();
      src.buffer = bellBuffer;
      src.connect(gain);
      src.start();
    });
  }

  // ── Pranayama timer ────────────────────────────────────────────────────────
  // ratio    – array [I, R, E, B] of matra counts (0 = phase skipped)
  // matraMs  – duration of one matra in milliseconds
  // Callbacks:
  //   onPhaseStart(phaseIdx, totalMatras)   – fired at phase transition
  //   onMatraTick(phaseIdx, matraIdx)       – fired at each within-phase matra boundary (after first)
  //   onCycleTick(msRemaining, matraIdx, totalMatras, phaseIdx) – fired every PRANA_TICK_MS for display
  //   onCycleComplete()                     – fired when one full cycle ends, before next starts
  runPranayamaTimer({ getRatio, matraMs, onPhaseStart, onMatraTick, onCycleTick, onCycleComplete }) {
    const PRANA_TICK_MS = 200;

    // Mutable cycle geometry — re-read from getRatio() at each cycle boundary.
    let phases, cycleDurationMs, cycleStartTime;

    const initCycle = () => {
      const ratio = getRatio();
      phases = ratio.map((matras, idx) => ({ idx, matras })).filter((p) => p.matras > 0);
      cycleDurationMs = phases.reduce((sum, p) => sum + p.matras * matraMs, 0);
      cycleStartTime = Date.now();
    };

    const stateAt = (msElapsed) => {
      let remaining = msElapsed;
      for (let pi = 0; pi < phases.length; pi++) {
        const phaseDur = phases[pi].matras * matraMs;
        if (remaining < phaseDur) {
          return {
            phasePos: pi,
            matraIdx: Math.floor(remaining / matraMs),
            msRemaining: phaseDur - remaining,
          };
        }
        remaining -= phaseDur;
      }
      const last = phases[phases.length - 1];
      return { phasePos: phases.length - 1, matraIdx: last.matras - 1, msRemaining: 0 };
    };

    // Kick off first cycle.
    initCycle();
    onPhaseStart(phases[0].idx, phases[0].matras);

    let lastPhasePos = 0;
    let lastMatraIdx = 0;

    this._pranaTimer = setInterval(() => {
      const elapsed = Date.now() - cycleStartTime;

      // Handle cycle completion (loop in case timer was throttled through multiple cycles).
      while (Date.now() - cycleStartTime >= cycleDurationMs) {
        onCycleComplete();
        initCycle(); // resets cycleStartTime; may adopt a new ratio
        lastPhasePos = 0;
        lastMatraIdx = 0;
        onPhaseStart(phases[0].idx, phases[0].matras);
      }

      const elapsedNow = Date.now() - cycleStartTime;
      const { phasePos, matraIdx, msRemaining } = stateAt(elapsedNow);
      const phase = phases[phasePos];

      // Phase boundary crossed.
      if (phasePos !== lastPhasePos) {
        lastPhasePos = phasePos;
        lastMatraIdx = matraIdx;
        onPhaseStart(phase.idx, phase.matras);
      }

      // Matra boundary crossed within phase.
      if (matraIdx !== lastMatraIdx) {
        lastMatraIdx = matraIdx;
        onMatraTick(phase.idx, matraIdx);
      }

      onCycleTick(Math.max(0, msRemaining), matraIdx, phase.matras, phase.idx);
    }, PRANA_TICK_MS);
  }

  stopPranayamaTimer() {
    if (this._pranaTimer) {
      clearInterval(this._pranaTimer);
      this._pranaTimer = null;
    }
  }
}
