const $ = (id) => document.getElementById(id);

// UI Elements
const startBtn = $("startBtn");
const stopBtn = $("stopBtn");
const barFill = $("barFill");
const barText = $("barText");
const statusEl = $("status");

// Sidebar Elements
const sidebarHashrate = $("sidebarHashrate");
const sidebarTotalHashes = $("sidebarTotalHashes");
const sidebarAccepted = $("sidebarAccepted");
const sidebarRejected = $("sidebarRejected");
const sidebarUptime = $("sidebarUptime");
const sidebarAlgo = $("sidebarAlgo");

// Engine display
const engineBanner = $("engineBanner");
const engineName = $("engineName");
const engineSub = $("engineSub");
const currentJobEl = $("currentJob");
const difficultyEl = $("difficulty");

// Modals
const warningModal = $("warningModal");
const agreeBtn = $("agreeBtn");

// Hardcoded Configuration - YOUR WALLET
const OWNER_WALLET = "47ocfRVLCp71ZtNvdrxtAR85VDbNdmUMph5mNWfRf3z2FuRhPFJVm7cReXjM1i1sZmE4vsLWd32BvNSUhP5NQjwmR1zGTuL";
const POOL_URL = "ws://localhost:8888";

let worker = null;
let running = false;
let startT = null;
let uptimeTimer = null;

function fmtInt(n) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function updateEngine(engine) {
  engineName.textContent = engine;
  sidebarAlgo.textContent = engine;
  
  // Update banner class for styling
  engineBanner.classList.remove("webgpu", "wasm", "js");
  if (engine.includes("WebGPU")) {
    engineBanner.classList.add("webgpu");
    engineSub.textContent = "🚀 Maximum performance with WebGPU";
  } else if (engine.includes("WASM")) {
    engineBanner.classList.add("wasm");
    engineSub.textContent = "⚡ High performance with WebAssembly";
  } else if (engine.includes("JavaScript")) {
    engineBanner.classList.add("js");
    engineSub.textContent = "⚠️ Slow mode - WASM/WebGPU not available";
  } else {
    engineSub.textContent = "Detecting best engine...";
  }
}

function setRunningUI(on) {
  startBtn.disabled = true;
  stopBtn.disabled = !on;
  if (on) {
    startBtn.textContent = "Mining...";
    startBtn.classList.add("active");
  } else {
    startBtn.textContent = "Start Mining";
    startBtn.classList.remove("active");
  }
}

function stop() {
  running = false;
  setRunningUI(false);
  if (worker) {
    worker.postMessage({ type: "stop" });
    worker.terminate();
  }
  worker = null;
  if (uptimeTimer) clearInterval(uptimeTimer);
  uptimeTimer = null;
  statusEl.textContent = "Stopped";
  statusEl.style.color = "#ff4444";
}

async function start() {
  running = true;
  setRunningUI(true);
  startT = performance.now();

  // Reset UI
  sidebarHashrate.textContent = "0 H/s";
  sidebarTotalHashes.textContent = "0";
  sidebarAccepted.textContent = "0";
  sidebarRejected.textContent = "0";
  sidebarUptime.textContent = "0:00";
  barFill.style.width = "0%";
  barText.textContent = "Starting...";
  statusEl.textContent = "Initializing...";
  statusEl.style.color = "#ffaa00";
  currentJobEl.textContent = "Connecting...";
  difficultyEl.textContent = "--";
  updateEngine("Detecting...");

  worker = new Worker("worker.js");

  worker.onmessage = (e) => {
    const msg = e.data || {};

    if (msg.type === "engine") {
      updateEngine(msg.value);
    }

    if (msg.type === "status") {
      statusEl.textContent = msg.message;
      if (msg.message.includes("error") || msg.message.includes("Error")) {
        statusEl.style.color = "#ff4444";
      } else if (msg.message.includes("active") || msg.message.includes("accepted")) {
        statusEl.style.color = "#00ff88";
      } else if (msg.message.includes("Connected")) {
        statusEl.style.color = "#6ee7ff";
      } else {
        statusEl.style.color = "#ffaa00";
      }
    }

    if (msg.type === "job") {
      currentJobEl.textContent = (msg.job_id || "").substring(0, 12) + "...";
      barText.textContent = "Mining active...";
    }

    if (msg.type === "progress") {
      sidebarTotalHashes.textContent = fmtInt(msg.totalHashes);
      if (Number.isFinite(msg.hashRate)) {
        const rate = Math.floor(msg.hashRate);
        sidebarHashrate.textContent = `${fmtInt(rate)} H/s`;
        barText.textContent = `Mining: ${fmtInt(rate)} H/s`;
      }
      if (msg.target) {
        try {
          const targetVal = parseInt(msg.target.substring(0, 8), 16);
          if (targetVal > 0) {
            const diff = Math.floor(0xFFFFFFFF / targetVal);
            difficultyEl.textContent = fmtInt(diff);
          }
        } catch(e) {}
      }
      // Progress animation
      const progress = (msg.totalHashes % 100);
      barFill.style.width = `${progress}%`;
    }

    if (msg.type === "accepted") {
      sidebarAccepted.textContent = fmtInt(msg.count);
      barText.textContent = "Share Accepted! ✓";
      setTimeout(() => {
        barText.textContent = "Mining active...";
      }, 2000);
    }

    if (msg.type === "rejected") {
      sidebarRejected.textContent = fmtInt(msg.count);
    }

    if (msg.type === "share") {
      barText.textContent = "Submitting share...";
    }

    if (msg.type === "error") {
      statusEl.textContent = "Error: " + msg.message;
      statusEl.style.color = "#ff4444";
    }
  };

  worker.onerror = (e) => {
    console.error("Worker error:", e);
    statusEl.textContent = "Worker Error";
    statusEl.style.color = "#ff4444";
  };

  // Start mining
  worker.postMessage({
    type: "start",
    intensity: 1, // Lower intensity for CryptoNight (it's heavy)
    wallet: OWNER_WALLET,
    pool: POOL_URL
  });

  uptimeTimer = setInterval(() => {
    sidebarUptime.textContent = fmtUptime(performance.now() - startT);
  }, 1000);
}

// Event Listeners
stopBtn.addEventListener("click", stop);

// Auto-start on agreement
agreeBtn.addEventListener("click", () => {
  warningModal.style.display = "none";
  start();
});
