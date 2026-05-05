import { AudioEngine } from "./audio-engine.js";
import { appState } from "./app-state.js";

const SETTINGS_STORAGE_KEY = "mc_settings_v2";

// ── Pranayama ratio presets ────────────────────────────────────────────────────
// Each ratio: [Puraka, Kumbhaka, Rechaka, Bahya] in matra units (0 = skipped).
const PRANAYAMA_RATIOS = [
  { label: "Beginner — 1 : 0 : 1",       short: "1 : 0 : 1",     ratio: [1, 0, 1, 0] },
  { label: "Beginner — 1 : 0 : 2",       short: "1 : 0 : 2",     ratio: [1, 0, 2, 0] },
  { label: "Early Interm. — 1 : 1 : 1",  short: "1 : 1 : 1",     ratio: [1, 1, 1, 0] },
  { label: "Early Interm. — 1 : 1 : 2",  short: "1 : 1 : 2",     ratio: [1, 1, 2, 0] },
  { label: "Intermediate — 1 : 2 : 2",   short: "1 : 2 : 2",     ratio: [1, 2, 2, 0] },
  { label: "Classical — 1 : 4 : 2 ★",    short: "1 : 4 : 2 ★",   ratio: [1, 4, 2, 0] },
  { label: "Advanced — 1 : 4 : 2 : 1",   short: "1 : 4 : 2 : 1", ratio: [1, 4, 2, 1] },
];
const PHASE_NAMES = ["PURAKA", "KUMBHAKA", "RECHAKA", "BAHYA"];
const PHASE_TRANS = ["inhale", "hold", "exhale", "hold out"];
const PHASE_COLORS = ["#8fbfdf", "#dfb87a", "#8fd4a8", "#b89fdf"]; // subtle per-phase tint

const els = {
  statusLine: document.getElementById("statusLine"),
  counterValue: document.getElementById("counterValue"),
  multipleN: document.getElementById("multipleN"),
  milestoneStrip: document.getElementById("milestoneStrip"),
  milestoneInner: document.getElementById("milestoneInner"),
  countBtn: document.getElementById("countBtn"),
  markEnabled: document.getElementById("markEnabled"),
  markSwitchText: document.getElementById("markSwitchText"),
  bellEnabled: document.getElementById("bellEnabled"),
  bellSwitchText: document.getElementById("bellSwitchText"),
  counterRegion: document.getElementById("counterRegion"),
  correctionLeft: document.getElementById("correctionLeft"),
  correctionRight: document.getElementById("correctionRight"),
  // Window-level buttons
  gearBtn: document.getElementById("gearBtn"),
  shareBtn: document.getElementById("shareBtn"),
  // Settings panel
  settingsPanel: document.getElementById("settingsPanel"),
  settingsOverlay: document.getElementById("settingsOverlay"),
  closeSettingsBtn: document.getElementById("closeSettingsBtn"),
  noiseCancellation: document.getElementById("noiseCancellation"),
  ncSwitchText: document.getElementById("ncSwitchText"),
  mantraGapMs: document.getElementById("mantraGapMs"),
  minSegmentMs: document.getElementById("minSegmentMs"),
  maxSegmentMs: document.getElementById("maxSegmentMs"),
  micSelect: document.getElementById("micSelect"),
  zeroHint: document.getElementById("zeroHint"),
  // Pranayama
  pranaPhaseName: document.getElementById("pranaPhaseName"),
  pranaCountdown: document.getElementById("pranaCountdown"),
  pranaRatioStrip: document.getElementById("pranaRatioStrip"),
  pranaCyclesLabel: document.getElementById("pranaCyclesLabel"),
  pranaControls: document.getElementById("pranaControls"),
  pranaRatioSelect: document.getElementById("pranaRatioSelect"),
  pranaMatraS: document.getElementById("pranaMatraS"),
  pranaStageBell: document.getElementById("pranaStageBell"),
  pranaStageBellText: document.getElementById("pranaStageBellText"),
  pranaMatraBell: document.getElementById("pranaMatraBell"),
  pranaMatraBellText: document.getElementById("pranaMatraBellText"),
  modeToggleBtn: document.getElementById("modeToggleBtn"),
  appTitle: document.getElementById("appTitle"),
  // Background
  bgLayer: document.getElementById("bgLayer"),
  bgEnabled: document.getElementById("bgEnabled"),
  bgEnabledText: document.getElementById("bgEnabledText"),
  bgOpacity: document.getElementById("bgOpacity"),
  bgBlur: document.getElementById("bgBlur"),
  // Install
  installBanner: document.getElementById("installBanner"),
  installNowBtn: document.getElementById("installNowBtn"),
  installLaterBtn: document.getElementById("installLaterBtn"),
};

const audioEngine = new AudioEngine();
let installTimer = null;

// ── Wake Lock ─────────────────────────────────────────────────────────────────

let wakeLock = null;

async function acquireWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
  } catch {
    // Denied or not supported — not fatal.
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}
let multipleHighlightTimer = null;

// Tracks the ratio currently running in the timer (may differ from
// appState.pranaRatioIndex when the user queues a change mid-cycle).
let pranaActiveRatioIndex = 0;

// ── Status ────────────────────────────────────────────────────────────────────

function updateStatus(text) {
  els.statusLine.textContent = text;
}

// ── Counter render ─────────────────────────────────────────────────────────────

function renderCount() {
  els.counterValue.textContent = String(appState.count);
  const isMultiple =
    appState.markEnabled && appState.count > 0 && appState.count % appState.n === 0;
  if (isMultiple) {
    els.counterValue.classList.add("multiple");
    if (multipleHighlightTimer) clearTimeout(multipleHighlightTimer);
    multipleHighlightTimer = setTimeout(() => {
      els.counterValue.classList.remove("multiple");
      multipleHighlightTimer = null;
    }, 1500);
  } else {
    if (multipleHighlightTimer) {
      clearTimeout(multipleHighlightTimer);
      multipleHighlightTimer = null;
    }
    els.counterValue.classList.remove("multiple");
  }
}

function renderMilestones() {
  const strip = els.milestoneStrip;
  const inner = els.milestoneInner;

  if (!appState.markEnabled || appState.count < appState.n) {
    strip.classList.add("hidden");
    inner.innerHTML = "";
    return;
  }

  strip.classList.remove("hidden");

  const hits = [];
  for (let x = appState.n; x <= appState.count; x += appState.n) {
    hits.push(x);
  }

  // Build: [n · ... · current] ··· [n · ... · (current-n)]
  // Then translateX to center the current span within the strip.
  let html = "";
  hits.forEach((v, i) => {
    if (i > 0) html += '<span class="ms-dot"> · </span>';
    const isCurrent = i === hits.length - 1;
    html += `<span class="${isCurrent ? "ms-current" : "ms-val"}">${v}</span>`;
  });

  if (hits.length > 1) {
    html += '<span class="ms-seam"> ··· </span>';
    hits.slice(0, -1).forEach((v, i) => {
      if (i > 0) html += '<span class="ms-dot"> · </span>';
      html += `<span class="ms-val ms-wrap">${v}</span>`;
    });
  }

  inner.innerHTML = html;
  inner.style.transform = "translateX(0px)";

  // Double-rAF: first frame removes hidden/updates DOM, second frame has full layout.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const cur = inner.querySelector(".ms-current");
    if (!cur) return;
    const stripRect = strip.getBoundingClientRect();
    const curRect = cur.getBoundingClientRect();
    const offset = stripRect.left + stripRect.width / 2 - (curRect.left + curRect.width / 2);
    inner.style.transform = `translateX(${Math.round(offset)}px)`;
  }));
}

function renderButton() {
  if (appState.mode === "pranayama") {
    els.countBtn.textContent = appState.counterRunning ? "Stop Pranayama" : "Start Pranayama";
  } else {
    els.countBtn.textContent = appState.counterRunning ? "Stop Counting" : "Count Mantras";
  }
  els.countBtn.classList.toggle("active", appState.counterRunning);
}

function renderSwitchText() {
  els.markSwitchText.textContent = appState.markEnabled ? "On" : "Off";
  els.bellSwitchText.textContent = appState.bellEnabled ? "Bell On" : "Bell Off";
  els.ncSwitchText.textContent = appState.noiseCancellation ? "On" : "Off";
  els.pranaStageBellText.textContent = appState.pranaStageBell ? "Stage \u266c" : "Stage \u266a";
  els.pranaMatraBellText.textContent = appState.pranaMatraBell ? "Tick \u266c" : "Tick \u266a";
}

// ── Pranayama render ─────────────────────────────────────────────────────────

function renderPranaPhase(phaseIdx, countdown, matraIdx, totalMatras) {
  const name = PHASE_NAMES[phaseIdx] ?? "–";
  const trans = PHASE_TRANS[phaseIdx] ?? "";
  const color = PHASE_COLORS[phaseIdx] ?? "var(--highlight)";

  els.pranaPhaseName.innerHTML = `${name} <span class="prana-phase-trans">(${trans})</span>`;
  els.pranaCountdown.textContent = String(Math.ceil(countdown / 1000));
  els.pranaCountdown.style.color = color;

  // Ratio strip: use the *active* ratio; show pending if user has queued a change.
  const ratio = PRANAYAMA_RATIOS[pranaActiveRatioIndex].ratio;
  const hasPending = appState.pranaRatioIndex !== pranaActiveRatioIndex;
  const parts = ratio.map((matras, idx) => {
    if (matras === 0) return null;
    const isActive = idx === phaseIdx;
    return `<span class="${isActive ? "prana-phase-active" : ""}" style="${isActive ? `color:${color}` : ""}">${matras}</span>`;
  }).filter(Boolean);
  let stripHtml = parts.join(' <span style="opacity:0.4"> · </span> ');
  if (hasPending) {
    stripHtml += ` <span style="opacity:0.45; font-size:0.75em"> \u2192 ${PRANAYAMA_RATIOS[appState.pranaRatioIndex].short}</span>`;
  }
  els.pranaRatioStrip.innerHTML = stripHtml;

  const currentCycle = appState.pranaCycles + 1;
  els.pranaCyclesLabel.textContent = hasPending
    ? `Cycle ${currentCycle} \u2192 1`
    : `Cycle ${currentCycle}`;
}

function populatePranaRatioSelect() {
  els.pranaRatioSelect.innerHTML = "";
  PRANAYAMA_RATIOS.forEach((preset, idx) => {
    const opt = document.createElement("option");
    opt.value = String(idx);
    opt.textContent = preset.short; // short label in folded state; swap to full on open
    els.pranaRatioSelect.appendChild(opt);
  });
  els.pranaRatioSelect.value = String(appState.pranaRatioIndex);
}

function applyModeClass() {
  const app = document.querySelector(".app");
  if (appState.mode === "pranayama") {
    app.classList.add("mode-pranayama");
    app.classList.remove("mode-mantra");
    els.appTitle.textContent = "True Heart Pranayama Counter";
    els.modeToggleBtn.title = "Switch to Mantra mode";
    els.zeroHint.textContent = "Hold to reset cycles";
  } else {
    app.classList.add("mode-mantra");
    app.classList.remove("mode-pranayama");
    els.appTitle.textContent = "True Heart Mantra Counter";
    els.modeToggleBtn.title = "Switch to Pranayama mode";
    els.zeroHint.textContent = "Hold to zero";
  }
}

// ── Settings panel ─────────────────────────────────────────────────────────────

// Populate the mic <select> with available audio input devices.
// Must be called after getUserMedia has been granted (labels are empty before).
async function populateMicList() {
  let devices;
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    return;
  }

  const inputs = devices.filter((d) => d.kind === "audioinput");
  const select = els.micSelect;
  const current = select.value;

  // Rebuild option list (keep "Default" as first entry)
  select.innerHTML = '<option value="">Default</option>';
  inputs.forEach((d) => {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `Microphone ${d.deviceId.slice(0, 8)}`;
    select.appendChild(opt);
  });

  // Restore persisted selection
  select.value = appState.micDeviceId || "";
  // If persisted device is no longer available, fall back to default
  if (select.value !== (appState.micDeviceId || "")) select.value = "";
}

function openSettings() {
  els.settingsPanel.classList.add("open");
  els.settingsOverlay.classList.add("visible");
  // Refresh device list each time the panel opens (devices can change)
  populateMicList();
}

function closeSettings() {
  els.settingsPanel.classList.remove("open");
  els.settingsOverlay.classList.remove("visible");
}

function syncSettingsInputs() {
  els.noiseCancellation.checked = appState.noiseCancellation;
  els.mantraGapMs.value = String(appState.mantraGapMs);
  els.minSegmentMs.value = String(appState.minSegmentMs);
  els.maxSegmentMs.value = String(appState.maxSegmentMs / 1000);
  renderSwitchText();
}

// ── Persist / load ─────────────────────────────────────────────────────────────

function persistSettings() {
  localStorage.setItem(
    SETTINGS_STORAGE_KEY,
    JSON.stringify({
      n: appState.n,
      markEnabled: appState.markEnabled,
      bellEnabled: appState.bellEnabled,
      noiseCancellation: appState.noiseCancellation,
      mantraGapMs: appState.mantraGapMs,
      minSegmentMs: appState.minSegmentMs,
      maxSegmentMs: appState.maxSegmentMs,
      micDeviceId: appState.micDeviceId,
      bgEnabled: appState.bgEnabled,
      bgOpacity: appState.bgOpacity,
      bgBlur: appState.bgBlur,
      mode: appState.mode,
      pranaRatioIndex: appState.pranaRatioIndex,
      pranaMatraS: appState.pranaMatraS,
      pranaStageBell: appState.pranaStageBell,
      pranaMatraBell: appState.pranaMatraBell,
    }),
  );
}

function loadPersistedState() {
  const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
  if (raw) {
    try {
      const p = JSON.parse(raw);
      appState.n = Number(p.n) || appState.n;
      appState.markEnabled = p.markEnabled ?? appState.markEnabled;
      appState.bellEnabled = p.bellEnabled ?? appState.bellEnabled;
      appState.noiseCancellation = p.noiseCancellation ?? appState.noiseCancellation;
      appState.mantraGapMs = Number.isFinite(p.mantraGapMs) ? p.mantraGapMs : appState.mantraGapMs;
      appState.minSegmentMs = Number.isFinite(p.minSegmentMs) ? p.minSegmentMs : appState.minSegmentMs;
      appState.maxSegmentMs = Number.isFinite(p.maxSegmentMs) ? p.maxSegmentMs : appState.maxSegmentMs;
      appState.micDeviceId = typeof p.micDeviceId === "string" ? p.micDeviceId : "";
      appState.bgEnabled = p.bgEnabled ?? appState.bgEnabled;
      appState.bgOpacity = Number.isFinite(p.bgOpacity) ? p.bgOpacity : appState.bgOpacity;
      appState.bgBlur = Number.isFinite(p.bgBlur) ? p.bgBlur : appState.bgBlur;
      if (p.mode === "mantra" || p.mode === "pranayama") appState.mode = p.mode;
      appState.pranaRatioIndex = Number.isFinite(p.pranaRatioIndex) ? Math.max(0, Math.min(p.pranaRatioIndex, PRANAYAMA_RATIOS.length - 1)) : appState.pranaRatioIndex;
      appState.pranaMatraS = Number.isFinite(p.pranaMatraS) ? p.pranaMatraS : appState.pranaMatraS;
      appState.pranaStageBell = p.pranaStageBell ?? appState.pranaStageBell;
      appState.pranaMatraBell = p.pranaMatraBell ?? appState.pranaMatraBell;
    } catch {
      localStorage.removeItem(SETTINGS_STORAGE_KEY);
    }
  }

  els.multipleN.value = String(appState.n);
  els.markEnabled.checked = appState.markEnabled;
  els.bellEnabled.checked = appState.bellEnabled;
  syncSettingsInputs();
  // Sync bg inputs
  els.bgEnabled.checked = appState.bgEnabled;
  els.bgOpacity.value = String(appState.bgOpacity);
  els.bgBlur.value = String(appState.bgBlur);
  applyBgSettings();
  populatePranaRatioSelect();
  els.pranaMatraS.value = String(appState.pranaMatraS);
  els.pranaStageBell.checked = appState.pranaStageBell;
  els.pranaMatraBell.checked = appState.pranaMatraBell;
  applyModeClass();
  renderSwitchText();
}

// ── Background image ──────────────────────────────────────────────────────────

function applyBgSettings() {
  const layer = els.bgLayer;
  if (!appState.bgEnabled) {
    layer.classList.add("bg-hidden");
    document.body.classList.remove("bg-active");
  } else {
    layer.classList.remove("bg-hidden");
    document.body.classList.add("bg-active");
    document.documentElement.style.setProperty("--bg-opacity", String(appState.bgOpacity / 100));
    document.documentElement.style.setProperty("--bg-blur", `${appState.bgBlur}px`);
  }
  els.bgEnabledText.textContent = appState.bgEnabled ? "On" : "Off";
}

// ── Bell ──────────────────────────────────────────────────────────────────────

let bellBuffer = null;
let bellDecodePromise = null;

function loadBell(ctx) {
  if (bellBuffer) return Promise.resolve(bellBuffer);
  if (bellDecodePromise) return bellDecodePromise;
  bellDecodePromise = fetch("src/bell.mp3")
    .then((r) => r.arrayBuffer())
    .then((ab) => ctx.decodeAudioData(ab))
    .then((buf) => { bellBuffer = buf; return buf; });
  return bellDecodePromise;
}

let tickBuffer = null;
let tickDecodePromise = null;

function loadTick(ctx) {
  if (tickBuffer) return Promise.resolve(tickBuffer);
  if (tickDecodePromise) return tickDecodePromise;
  tickDecodePromise = fetch("src/tick.mp3")
    .then((r) => r.arrayBuffer())
    .then((ab) => ctx.decodeAudioData(ab))
    .then((buf) => { tickBuffer = buf; return buf; });
  return tickDecodePromise;
}

// Ensure bell buffer is loaded then play at given volume.
function playBell(volume = 1.0) {
  if (!audioEngine.ctx) return;
  audioEngine.ctx.resume().then(() => {
    loadBell(audioEngine.ctx).then((buf) => {
      audioEngine.playBell(buf, volume);
    });
  });
}

// Mantra bell (full volume on multiples of N).
function playBellIfNeeded() {
  if (!appState.bellEnabled) return;
  playBell(1.0);
}

// Pranayama: single bell at phase start.
function playPranaStagebell() {
  if (!appState.pranaStageBell) return;
  playBell(1.0);
}

// Pranayama: 1 soft tick at matra boundary using tick.mp3.
function playPranaMatraBell() {
  if (!appState.pranaMatraBell) return;
  if (!audioEngine.ctx) return;
  audioEngine.ctx.resume().then(() => {
    loadTick(audioEngine.ctx).then((buf) => {
      audioEngine.playBell(buf, 0.6);
    });
  });
}

// ── Counter logic ─────────────────────────────────────────────────────────────

function onSegment() {
  appState.count += 1;
  renderCount();
  renderMilestones();

  if (appState.markEnabled && appState.count % appState.n === 0) {
    playBellIfNeeded();
  }
}

function resetCounter() {
  if (appState.mode === "pranayama") {
    appState.pranaCycles = 0;
    els.pranaCyclesLabel.textContent = "Cycle 1";
    updateStatus("Cycles reset");
  } else {
    appState.count = 0;
    renderCount();
    renderMilestones();
    updateStatus("Counter reset");
  }
}

function endCounterMode() {
  appState.counterRunning = false;
  releaseWakeLock();
  if (appState.mode === "pranayama") {
    audioEngine.stopPranayamaTimer();
  } else {
    audioEngine.stopSegmentStream();
    audioEngine.stopAll();
  }
  updateStatus(appState.mode === "pranayama" ? "Pranayama stopped." : "Counting stopped");
  renderButton();
}

// Fully tear down the audio engine and leave it in a clean, re-init-ready state.
// Used during mode switches so that no stale AudioContext or mic tracks carry
// over between modes (important on Android where rapid stop / re-request of
// getUserMedia can leave the engine in a bad state).
async function teardownAudioEngine() {
  audioEngine.stopSegmentStream();
  audioEngine.stopPranayamaTimer();
  audioEngine.stopAll();
}

async function startCounterMode() {
  if (appState.mode === "pranayama") {
    await startPranayamaMode();
    return;
  }
  try {
    await audioEngine.init({
      noiseCancellation: appState.noiseCancellation,
      deviceId: appState.micDeviceId,
    });
  } catch (err) {
    updateStatus(`Microphone error: ${err.message}`);
    renderButton();
    return;
  }

  try {
    await audioEngine.calibrateNoise();
  } catch (err) {
    updateStatus(`Noise calibration failed: ${err.message}`);
    renderButton();
    return;
  }

  appState.counterRunning = true;
  updateStatus("Listening\u2026 each sound burst counts as one mantra.");
  renderButton();
  acquireWakeLock();

  audioEngine.runSegmentStream({
    onSegment,
    mantraGapMs: appState.mantraGapMs,
    minSegmentMs: appState.minSegmentMs,
    maxSegmentMs: appState.maxSegmentMs,
  });
}

async function startPranayamaMode() {
  // Sync active ratio at session start (clears any stale pending state).
  pranaActiveRatioIndex = appState.pranaRatioIndex;
  if (!audioEngine.ctx) {
    audioEngine.ctx = new AudioContext({ sampleRate: 48000 });
  }
  await audioEngine.ctx.resume();

  appState.pranaCycles = 0;
  appState.counterRunning = true;
  updateStatus("Pranayama active\u2026 follow the phase cues.");
  renderButton();
  acquireWakeLock();

  const matraMs = appState.pranaMatraS * 1000;

  audioEngine.runPranayamaTimer({
    getRatio: () => PRANAYAMA_RATIOS[appState.pranaRatioIndex].ratio,
    matraMs,
    onPhaseStart(phaseIdx, totalMatras) {
      renderPranaPhase(phaseIdx, totalMatras * matraMs, 0, totalMatras);
      playPranaStagebell();
    },
    onMatraTick(phaseIdx, matraIdx) {
      playPranaMatraBell();
    },
    onCycleTick(msRemaining, matraIdx, totalMatras, phaseIdx) {
      renderPranaPhase(phaseIdx, msRemaining, matraIdx, totalMatras);
    },
    onCycleComplete() {
      if (appState.pranaRatioIndex !== pranaActiveRatioIndex) {
        // Adopt queued ratio at cycle boundary and reset count.
        pranaActiveRatioIndex = appState.pranaRatioIndex;
        appState.pranaCycles = 0;
      } else {
        appState.pranaCycles += 1;
      }
    },
  });
}

async function toggleMode() {
  if (appState.counterRunning) endCounterMode();
  // Always fully teardown the audio engine before switching modes.
  // On Android, a partial shutdown (e.g. only stopSegmentStream without
  // stopAll when coming from mantra mode, or a leftover context from an
  // earlier session) can cause the next init() to fail silently, making
  // the "Count Mantras" button appear unresponsive.
  await teardownAudioEngine();
  appState.mode = appState.mode === "mantra" ? "pranayama" : "mantra";
  applyModeClass();
  renderButton();
  renderSwitchText();
  persistSettings();
  if (appState.mode === "pranayama") {
    updateStatus("Pranayama mode — tap Start Pranayama when ready.");
    pranaActiveRatioIndex = appState.pranaRatioIndex; // clear any pending state
    renderPranaPhase(0, PRANAYAMA_RATIOS[appState.pranaRatioIndex].ratio[0] * appState.pranaMatraS * 1000, 0, PRANAYAMA_RATIOS[appState.pranaRatioIndex].ratio[0]);
  } else {
    updateStatus("Mantra mode.");
    renderCount();
    renderMilestones();
  }
}

// ── Long-press counter reset + quick-tap corrections ──────────────────────────

function setupCounterLongPress() {
  const RESET_MS = 2000;
  let resetTimer = null;
  let tapZone = null; // "left" | "right" | "middle"
  let tapHandled = false;
  let endProcessed = false; // guard against duplicate pointer-end events

  function getTapZone(e) {
    const rect = els.counterRegion.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const ratio = x / rect.width;
    if (ratio < 0.3) return "left";
    if (ratio > 0.7) return "right";
    return "middle";
  }

  function onPressStart(e) {
    tapZone = getTapZone(e);
    tapHandled = false;
    endProcessed = false;
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      resetCounter();
      tapHandled = true;
    }, RESET_MS);
  }

  function onPressEnd() {
    if (endProcessed) return;
    endProcessed = true;

    if (resetTimer) {
      clearTimeout(resetTimer);
      resetTimer = null;
    }
    if (tapHandled) return; // long-press already consumed

    // Quick tap — only in mantra mode.
    if (appState.mode !== "mantra") return;

    if (tapZone === "left") {
      appState.count = Math.max(0, appState.count - 1);
      renderCount();
      renderMilestones();
      flashCorrection(els.correctionLeft);
    } else if (tapZone === "right") {
      appState.count += 1;
      renderCount();
      renderMilestones();
      flashCorrection(els.correctionRight);
    }
  }

  function flashCorrection(el) {
    el.style.background = "rgba(255,255,255,0.18)";
    el.style.color = "rgba(215,221,229,0.9)";
    setTimeout(() => {
      el.style.background = "";
      el.style.color = "";
    }, 150);
  }

  els.counterRegion.addEventListener("pointerdown", onPressStart);
  els.counterRegion.addEventListener("pointerup", onPressEnd);
  els.counterRegion.addEventListener("pointercancel", onPressEnd);
  els.counterRegion.addEventListener("pointerleave", onPressEnd);
  document.querySelector(".app").addEventListener("contextmenu", (e) => e.preventDefault());
}

// ── Install banner ────────────────────────────────────────────────────────────

function setupInstallBanner() {
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches;
  const firstVisitDone = sessionStorage.getItem("mc_install_seen") === "1";

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    appState.deferredInstallPrompt = event;

    if (firstVisitDone || isStandalone) return;

    els.installBanner.classList.remove("hidden");
    if (installTimer) clearTimeout(installTimer);
    installTimer = setTimeout(() => {
      els.installBanner.classList.add("hidden");
      sessionStorage.setItem("mc_install_seen", "1");
    }, 5000);
  });

  const triggerInstall = async () => {
    if (!appState.deferredInstallPrompt) return;
    appState.deferredInstallPrompt.prompt();
    await appState.deferredInstallPrompt.userChoice;
    appState.deferredInstallPrompt = null;
    els.installBanner.classList.add("hidden");
    sessionStorage.setItem("mc_install_seen", "1");
  };

  els.installNowBtn.addEventListener("click", triggerInstall);

  els.installLaterBtn.addEventListener("click", () => {
    els.installBanner.classList.add("hidden");
    sessionStorage.setItem("mc_install_seen", "1");
  });
}

// ── Share ─────────────────────────────────────────────────────────────────────

function setupShareButton() {
  els.shareBtn.addEventListener("click", async () => {
    const shareData = {
      title: "True Heart Mantra Counter",
      text: "A browser-based mantra repetition counter and pranayama timer. Uses your microphone to detect sound bursts — no installation needed.",
      url: window.location.href,
    };

    if (navigator.share) {
      try {
        await navigator.share(shareData);
      } catch (err) {
        // User cancelled or share failed — not an error worth surfacing.
        if (err.name !== "AbortError") {
          fallbackCopy(shareData.url);
        }
      }
    } else {
      fallbackCopy(shareData.url);
    }
  });
}

function fallbackCopy(url) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).then(
      () => updateStatus("Link copied to clipboard"),
      () => updateStatus("Could not copy link"),
    );
  } else {
    // Last resort: select a temporary input element.
    const input = document.createElement("input");
    input.value = url;
    input.style.position = "fixed";
    input.style.left = "-9999px";
    document.body.appendChild(input);
    input.select();
    try {
      document.execCommand("copy");
      updateStatus("Link copied to clipboard");
    } catch {
      updateStatus("Could not copy link");
    }
    document.body.removeChild(input);
  }
}

// ── Events ────────────────────────────────────────────────────────────────────

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

function setupEvents() {
  // Main button
  els.countBtn.addEventListener("click", async () => {
    if (appState.counterRunning) {
      endCounterMode();
      return;
    }
    await startCounterMode();
  });

  // Mark multiples
  els.multipleN.addEventListener("change", () => {
    const n = Number(els.multipleN.value);
    appState.n = Number.isFinite(n) && n > 0 ? Math.floor(n) : 9;
    els.multipleN.value = String(appState.n);
    renderCount();
    renderMilestones();
    persistSettings();
  });

  els.markEnabled.addEventListener("change", () => {
    appState.markEnabled = els.markEnabled.checked;
    renderSwitchText();
    renderCount();
    renderMilestones();
    persistSettings();
  });

  els.bellEnabled.addEventListener("change", () => {
    appState.bellEnabled = els.bellEnabled.checked;
    renderSwitchText();
    persistSettings();
  });

  // Settings panel open/close
  els.gearBtn.addEventListener("click", openSettings);
  els.closeSettingsBtn.addEventListener("click", closeSettings);
  els.settingsOverlay.addEventListener("click", closeSettings);

  // Microphone selection
  els.micSelect.addEventListener("change", () => {
    appState.micDeviceId = els.micSelect.value;
    persistSettings();
    audioEngine.setMicDevice(appState.micDeviceId).catch((err) => {
      console.warn("Mic switch failed:", err);
    });
  });

  // Noise cancellation toggle
  els.noiseCancellation.addEventListener("change", () => {
    appState.noiseCancellation = els.noiseCancellation.checked;
    renderSwitchText();
    persistSettings();
    // Rewire the audio graph live; no need to stop counting.
    audioEngine.setNoiseCancellation(appState.noiseCancellation).catch((err) => {
      console.warn("NC toggle failed:", err);
    });
  });

  // Detection parameters
  els.mantraGapMs.addEventListener("change", () => {
    appState.mantraGapMs = clampInt(els.mantraGapMs.value, 100, 2000, 550);
    els.mantraGapMs.value = String(appState.mantraGapMs);
    persistSettings();
    if (appState.counterRunning) {
      audioEngine.updateSegmentParams({
        mantraGapMs: appState.mantraGapMs,
        minSegmentMs: appState.minSegmentMs,
        maxSegmentMs: appState.maxSegmentMs,
      });
    }
  });

  els.minSegmentMs.addEventListener("change", () => {
    appState.minSegmentMs = clampInt(els.minSegmentMs.value, 50, 500, 150);
    els.minSegmentMs.value = String(appState.minSegmentMs);
    persistSettings();
    if (appState.counterRunning) {
      audioEngine.updateSegmentParams({
        mantraGapMs: appState.mantraGapMs,
        minSegmentMs: appState.minSegmentMs,
        maxSegmentMs: appState.maxSegmentMs,
      });
    }
  });

  els.maxSegmentMs.addEventListener("change", () => {
    appState.maxSegmentMs = clampInt(els.maxSegmentMs.value, 1, 60, 18) * 1000;
    els.maxSegmentMs.value = String(appState.maxSegmentMs / 1000);
    persistSettings();
    if (appState.counterRunning) {
      audioEngine.updateSegmentParams({
        mantraGapMs: appState.mantraGapMs,
        minSegmentMs: appState.minSegmentMs,
        maxSegmentMs: appState.maxSegmentMs,
      });
    }
  });

  // Background image controls
  els.bgEnabled.addEventListener("change", () => {
    appState.bgEnabled = els.bgEnabled.checked;
    applyBgSettings();
    persistSettings();
  });

  els.bgOpacity.addEventListener("input", () => {
    appState.bgOpacity = clampInt(els.bgOpacity.value, 0, 100, 45);
    applyBgSettings();
  });
  els.bgOpacity.addEventListener("change", () => {
    appState.bgOpacity = clampInt(els.bgOpacity.value, 0, 100, 45);
    els.bgOpacity.value = String(appState.bgOpacity);
    applyBgSettings();
    persistSettings();
  });

  els.bgBlur.addEventListener("input", () => {
    appState.bgBlur = clampInt(els.bgBlur.value, 0, 20, 3);
    applyBgSettings();
  });
  els.bgBlur.addEventListener("change", () => {
    appState.bgBlur = clampInt(els.bgBlur.value, 0, 20, 3);
    els.bgBlur.value = String(appState.bgBlur);
    applyBgSettings();
    persistSettings();
  });

  // Mode toggle
  els.modeToggleBtn.addEventListener("click", toggleMode);

  // Pranayama controls
  // Swap option labels: short in folded state, full when dropdown is open.
  const pranaSelectCollapseToShort = () => {
    PRANAYAMA_RATIOS.forEach((p, i) => { els.pranaRatioSelect.options[i].textContent = p.short; });
  };
  els.pranaRatioSelect.addEventListener("mousedown", () => {
    PRANAYAMA_RATIOS.forEach((p, i) => { els.pranaRatioSelect.options[i].textContent = p.label; });
  });
  els.pranaRatioSelect.addEventListener("keydown", () => {
    PRANAYAMA_RATIOS.forEach((p, i) => { els.pranaRatioSelect.options[i].textContent = p.label; });
  });
  els.pranaRatioSelect.addEventListener("blur", pranaSelectCollapseToShort);
  els.pranaRatioSelect.addEventListener("change", () => {
    appState.pranaRatioIndex = Number(els.pranaRatioSelect.value);
    persistSettings();
    if (appState.counterRunning && appState.mode === "pranayama") {
      // Running: queue — takes effect at next cycle boundary; show hint via renderPranaPhase.
      updateStatus("Ratio queued \u2014 takes effect after this cycle.");
    } else {
      // Stopped: apply immediately and re-render.
      pranaActiveRatioIndex = appState.pranaRatioIndex;
      appState.pranaCycles = 0;
      if (appState.mode === "pranayama") {
        const puraka = PRANAYAMA_RATIOS[pranaActiveRatioIndex].ratio[0];
        renderPranaPhase(0, puraka * appState.pranaMatraS * 1000, 0, puraka);
      }
    }
    setTimeout(() => { pranaSelectCollapseToShort(); els.pranaRatioSelect.blur(); }, 500);
  });

  els.pranaMatraS.addEventListener("change", () => {
    appState.pranaMatraS = clampInt(els.pranaMatraS.value, 1, 60, 4);
    els.pranaMatraS.value = String(appState.pranaMatraS);
    persistSettings();
  });

  els.pranaStageBell.addEventListener("change", () => {
    appState.pranaStageBell = els.pranaStageBell.checked;
    renderSwitchText();
    persistSettings();
  });

  els.pranaMatraBell.addEventListener("change", () => {
    appState.pranaMatraBell = els.pranaMatraBell.checked;
    renderSwitchText();
    persistSettings();
  });
}

// ── PWA ───────────────────────────────────────────────────────────────────────

function registerPwa() {
  if (!("serviceWorker" in navigator)) return;

  const host = window.location.hostname;
  if (host === "127.0.0.1" || host === "localhost") {
    navigator.serviceWorker
      .getRegistrations()
      .then((regs) => Promise.all(regs.map((r) => r.unregister())))
      .catch(() => {});
    return;
  }

  navigator.serviceWorker.register("./sw.js").catch(() => {
    updateStatus("Service worker registration failed.");
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

function bootstrap() {
  loadPersistedState();
  pranaActiveRatioIndex = appState.pranaRatioIndex; // sync after persisted load
  setupEvents();
  setupCounterLongPress();
  setupInstallBanner();
  setupShareButton();
  renderButton();
  renderSwitchText();
  renderCount();
  renderMilestones();
  if (appState.mode === "pranayama") {
    const puraka = PRANAYAMA_RATIOS[appState.pranaRatioIndex].ratio[0];
    renderPranaPhase(0, puraka * appState.pranaMatraS * 1000, 0, puraka);
  }
  registerPwa();

  // Re-acquire wake lock and resume AudioContext when tab becomes visible again
  // (screen unlock, tab switch back). Keeps pranayama timing and audio intact.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (audioEngine.ctx) audioEngine.ctx.resume().catch(() => {});
    if (appState.counterRunning) acquireWakeLock();
  });
}

bootstrap();
