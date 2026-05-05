export const appState = {
  // Mantra mode
  count: 0,
  n: 9,
  markEnabled: true,
  counterRunning: false,
  bellEnabled: true,
  // Settings panel
  noiseCancellation: false,
  mantraGapMs: 1250,
  minSegmentMs: 150,
  maxSegmentMs: 18000,
  micDeviceId: "",
  bgEnabled: true,
  bgOpacity: 45,
  bgBlur: 3,
  // Pranayama mode
  mode: "mantra",           // "mantra" | "pranayama"
  pranaRatioIndex: 5,       // index into PRANAYAMA_RATIOS (Classical 1:4:2)
  pranaMatraS: 4,           // matra duration in seconds
  pranaStageBell: true,     // 2 bells at phase start
  pranaMatraBell: true,    // 1 soft bell at each within-phase matra tick
  pranaCycles: 0,           // completed breath cycles
  deferredInstallPrompt: null,
};
