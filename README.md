# True Heart Mantra Counter

A browser-based mantra repetition counter and pranayama timer. Uses your microphone to detect sound bursts — no installation or backend required. Runs offline as a PWA.

## Mantra Mode

Speak, chant, or produce any distinct sound — each burst increments the counter. Sensitivity adapts automatically via noise-floor calibration.

- **Milestone tracking** — mark multiples of a chosen number (default 9)
- **Bell** — sounds on each milestone
- **Manual corrections** — tap left/right edge of counter for −1 / +1
- **Long-press** counter to reset

## Pranayama Mode

Guided breathing with configurable ratios and matra durations. Visual countdown shows the current phase (Puraka / Kumbhaka / Rechaka / Bahya), seconds remaining, and cycle count.

- **7 ratio presets** — from Beginner (1:0:1) to Advanced (1:4:2:1)
- **Matra length** — 1–60 seconds (default 4 s)
- **Audio cues** — bell at phase transitions, soft tick at each matra boundary
- **Queued ratio changes** — take effect cleanly at the next cycle boundary

## Audio Engine

- Voice activity detection based on RMS energy + spectral flux, sampled every 50 ms
- Adaptive noise-floor tracking — no manual threshold needed
- Optional **RNNoise** AI noise cancellation (WebAssembly, runs in an AudioWorklet thread)
- Adjustable pre-gain and dynamics compression for quiet microphones

## Settings

Accessible via the gear icon. All settings persist in `localStorage`.

| Setting | Description |
|---------|-------------|
| Microphone input | Select a specific device |
| Noise cancellation | Toggle RNNoise processing |
| Mantra gap (ms) | Merge sounds closer than this |
| Min mantra length (ms) | Ignore sounds shorter than this |
| Max mantra length (s) | Force-close runaway segments |
| Background | Toggle image, adjust darkness and blur |

## Running locally

```
cd /home/tomek/JayaAppOrg/mantracounter.github.io
npx serve .
```

Or use the included `server.sh` script. For full PWA features (service worker, offline), serve over HTTPS or `localhost`.

## Installing as PWA

Install from the browser's install prompt or the button in Settings. The service worker caches all assets so the app works fully offline.

## Files

```
index.html
manifest.json
sw.js
src/
  main.js              — UI, events, render
  app-state.js         — shared state + localStorage persistence
  audio-engine.js      — Web Audio graph, VAD, segment detection, pranayama timer
  rnnoise-sync.js      — RNNoise WASM (Emscripten)
  rnnoise-processor.js — AudioWorklet wrapper for RNNoise
  styles.css           — all styles
  bell.mp3             — milestone bell sound
  tick.mp3             — pranayama matra tick
  background.jpg       — background image
  ornament.png         — decorative divider
  icon.png             — app icon
```
