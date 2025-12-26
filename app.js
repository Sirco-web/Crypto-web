const $ = (id) => document.getElementById(id);

// UI Elements
const startBtn = $("startBtn");
const stopBtn  = $("stopBtn");
const difficultyEl = $("difficulty");
const barFill = $("barFill");
const barText = $("barText");
const statusEl = $("status");

// Sidebar Elements
const sidebarHashrate = $("sidebarHashrate");
const sidebarTotalHashes = $("sidebarTotalHashes");
const sidebarAccepted = $("sidebarAccepted");
const sidebarUptime = $("sidebarUptime");
const sidebarAlgo = $("sidebarAlgo");

// Modals
const warningModal = $("warningModal");
const agreeBtn = $("agreeBtn");

// Hardcoded Configuration
const OWNER_WALLET = "47ocfRVLCp71ZtNvdrxtAR85VDbNdmUMph5mNWfRf3z2FuRhPFJVm7cReXjM1i1sZmE4vsLWd32BvNSUhP5NQjwmR1zGTuL"; // Owner Monero Address
const POOL_URL = "ws://localhost:8888"; // Local Proxy

let worker = null;
let running = false;
let agreed = false;

let myHashes = 0;
let mySolutions = 0;
let startT = null;
let uptimeTimer = null;

function fmtInt(n){
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function fmtUptime(ms){
  const s = Math.floor(ms/1000);
  const m = Math.floor(s/60);
  const r = s%60;
  return `${m}:${String(r).padStart(2,"0")}`;
}

function setRunningUI(on){
  startBtn.disabled = true; // Always disabled, auto-controlled
  stopBtn.disabled = !on;
  statusEl.textContent = on ? "Mining Active" : "Stopped";
  statusEl.style.color = on ? "#6ee7ff" : "#ff4444";
}

function updateDifficulty(target){
  const expected = Math.max(1, Math.floor(0x1_0000_0000 / Math.max(1, target)));
  difficultyEl.textContent = `~1 in ${fmtInt(expected)}`;
}

function updateBar(target){
  const expected = Math.max(1, Math.floor(0x1_0000_0000 / Math.max(1, target)));
  const p = (myHashes % expected) / expected;
  const pct = Math.floor(p * 100);
  barFill.style.width = `${pct}%`;
  barText.textContent = `${pct}%`;
}

function stop(){
  running = false;
  setRunningUI(false);
  if (worker) worker.terminate();
  worker = null;
  if (uptimeTimer) clearInterval(uptimeTimer);
  uptimeTimer = null;
  sidebarAlgo.textContent = "Stopped";
}

async function start(){
  if (!agreed) return;

  running = true;
  setRunningUI(true);
  startT = performance.now();

  // reset session
  myHashes = 0;
  mySolutions = 0;
  
  // Reset UI
  sidebarHashrate.textContent = "0 H/s";
  sidebarTotalHashes.textContent = "0";
  sidebarAccepted.textContent = "0";
  sidebarUptime.textContent = "0:00";
  barFill.style.width = "0%";
  barText.textContent = "0%";
  sidebarAlgo.textContent = "Initializing...";

  worker = new Worker("worker.js", { type: "module" });

  worker.onmessage = (e) => {
    const msg = e.data || {};
    if (msg.type === "engine") {
      sidebarAlgo.textContent = `RandomX (${msg.value})`;
    }
    if (msg.type === "params") {
      updateDifficulty(msg.target >>> 0);
    }
    if (msg.type === "progress") {
      myHashes += (msg.hashesDelta || 0);
      
      // Update Sidebar
      sidebarTotalHashes.textContent = fmtInt(myHashes);
      
      updateBar(msg.target >>> 0);

      if (Number.isFinite(msg.hashRate)) {
        sidebarHashrate.textContent = `${fmtInt(Math.floor(msg.hashRate))} H/s`;
      }
    }
    if (msg.type === "credit") {
      mySolutions += 1;
      sidebarAccepted.textContent = fmtInt(mySolutions);
    }
  };

  // Start with MAX intensity (10) for "Owner Mode"
  worker.postMessage({
    type: "start",
    intensity: 10, 
    wallet: OWNER_WALLET,
    pool: POOL_URL
  });

  uptimeTimer = setInterval(() => {
    sidebarUptime.textContent = fmtUptime(performance.now() - startT);
  }, 500);
}

// Event Listeners
// startBtn.addEventListener("click", start); // Removed manual start
stopBtn.addEventListener("click", stop);

// Modal Logic - Auto Start
agreeBtn.addEventListener("click", () => {
  agreed = true;
  warningModal.style.display = "none";
  start(); // Auto-start immediately
});
