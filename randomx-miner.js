// =============================================================================
// RANDOMX WEB MINER v3.9.0 - Demo-Compatible Implementation
// =============================================================================
// Mirrors the Vectra demo structure exactly for proven working RandomX mining
// Uses web-randomx.wasm for actual RandomX hashing
// =============================================================================

(function() {
  'use strict';
  
  // Configuration (set by index.html)
  const config = {
    proxy: window.rightProxy || 'wss://respectable-gilemette-timco-f0e524a9.koyeb.app/proxy',
    wallet: window.CONFIG?.WALLET || '',
    worker: window.CONFIG?.WORKER_NAME || 'web_miner',
    pool: window.rightPool || 'gulf.moneroocean.stream:10001',
    algo: window.rightalgo || 'rx/0'
  };
  
  // State
  let ws = null;
  let mineWorkers = [];
  let currentJob = null;
  let totalHashes = 0;
  let acceptedHashes = 0;
  let isRunning = false;
  let reconnectTimeout = null;
  
  // Export globals for compatibility
  window.ws = null;
  window.workers = [];
  window.totalhashes = 0;
  window.acceptedhashes = 0;
  window.job = null;
  
  // ==========================================================================
  // Get base URL for loading WASM files
  // ==========================================================================
  
  function getBaseUrl() {
    if (typeof window !== 'undefined') {
      const scripts = document.getElementsByTagName('script');
      for (let i = 0; i < scripts.length; i++) {
        const src = scripts[i].src;
        if (src && src.includes('randomx-miner.js')) {
          return src.substring(0, src.lastIndexOf('/') + 1);
        }
      }
      // Fall back to current location
      return window.location.origin + window.location.pathname.replace(/\/[^\/]*$/, '/');
    }
    return './';
  }
  
  const BASE_URL = getBaseUrl();
  
  // ==========================================================================
  // WORKER CODE - Exact match to Vectra demo's wrapper.js
  // ==========================================================================
  
  function createWorkerCode() {
    // This worker code matches the demo's worker.js + wrapper.js exactly
    return `
// ============================================================
// RandomX Worker - Matches Vectra demo wrapper.js exactly
// ============================================================

const BASE_URL = '${BASE_URL}';

let Module = null;
let input = null;
let output = null;
let seedInput = null;
let target = new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255]);
let throttleWait = 0;
let throttledStart = 0;
let throttledHashes = 0;
let currentJob = null;
let blob = [];
let variant = 0;
let height = 0;
let isReady = false;
let pendingJob = null;

// Initialize RandomX WASM module
async function initModule() {
  try {
    console.log('[Worker] Loading RandomX WASM from:', BASE_URL);
    
    // Fetch and compile the WASM module
    const wasmResponse = await fetch(BASE_URL + 'web-randomx.wasm');
    if (!wasmResponse.ok) {
      throw new Error('Failed to fetch WASM: ' + wasmResponse.status);
    }
    const wasmBuffer = await wasmResponse.arrayBuffer();
    
    // Fetch the JS module
    const jsResponse = await fetch(BASE_URL + 'web-randomx.js');
    if (!jsResponse.ok) {
      throw new Error('Failed to fetch JS: ' + jsResponse.status);
    }
    const jsText = await jsResponse.text();
    
    // The web-randomx.js exports a Module factory function
    // We need to evaluate it and call Module() with options
    // The script creates a global 'Module' function
    const scriptWithExport = jsText + '; Module;';
    const moduleFactory = eval(scriptWithExport);
    
    // Initialize the module with the WASM binary
    Module = await moduleFactory({
      wasmBinary: wasmBuffer,
      locateFile(path) {
        if (path.endsWith('.wasm')) {
          return BASE_URL + 'web-randomx.wasm';
        }
        return path;
      }
    });
    
    // Allocate memory buffers (exactly like demo's wrapper.js)
    input = new Uint8Array(Module.HEAPU8.buffer, Module._malloc(256), 256);
    output = new Uint8Array(Module.HEAPU8.buffer, Module._malloc(32), 32);
    seedInput = new Uint8Array(Module.HEAPU8.buffer, Module._malloc(32), 32);
    
    isReady = true;
    
    console.log('[Worker] RandomX WASM initialized successfully');
    
    // Send ready signal (demo uses plain 'ready' string)
    self.postMessage('ready');
    
    // If we received a job while loading, start mining now
    if (pendingJob) {
      console.log('[Worker] Processing pending job...');
      setJob(pendingJob);
      pendingJob = null;
      work();
    }
    
  } catch (error) {
    console.error('[Worker] WASM init failed:', error);
    self.postMessage({ error: error.message });
  }
}

// Helper: hex string to bytes
function hexToBytes(hex) {
  const len = hex.length / 2;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; ++i) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

// Helper: bytes to hex string
function bytesToHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; ++i) {
    hex += (bytes[i] >>> 4).toString(16);
    hex += (15 & bytes[i]).toString(16);
  }
  return hex;
}

// Check if hash meets target (compare from end)
function meetsTarget(output, target) {
  for (let i = 1; i <= target.length; ++i) {
    if (output[output.length - i] > target[target.length - i]) {
      return false;
    }
    if (output[output.length - i] < target[target.length - i]) {
      return true;
    }
  }
  return false;
}

// Set job from pool (exactly like demo's wrapper.js)
function setJob(data) {
  currentJob = data;
  blob = hexToBytes(data.blob);
  input.set(blob);
  
  const targetBytes = hexToBytes(data.target);
  if (targetBytes.length <= 8) {
    for (let i = 1; i <= targetBytes.length; ++i) {
      target[target.length - i] = targetBytes[targetBytes.length - i];
    }
    for (let i = 0; i < target.length - targetBytes.length; ++i) {
      target[i] = 255;
    }
  } else {
    target = targetBytes;
  }
  
  variant = data.variant === undefined ? 0 : data.variant;
  height = data.height === undefined ? 0 : data.height;
  
  if (data.seed_hash) {
    const seedBlob = hexToBytes(data.seed_hash);
    seedInput.set(seedBlob);
  }
  
  console.log('[Worker] Job set:', data.job_id, 'target:', data.target);
}

// Get current timestamp
function now() {
  return self.performance ? self.performance.now() : Date.now();
}

// Perform one hash (exactly like demo's wrapper.js)
function hash() {
  // Generate random nonce
  const nonce = (4294967295 * Math.random() + 1) >>> 0;
  input[39] = (4278190080 & nonce) >> 24;
  input[40] = (16711680 & nonce) >> 16;
  input[41] = (65280 & nonce) >> 8;
  input[42] = (255 & nonce) >> 0;
  
  // Call RandomX hash function (exactly like demo)
  return Module._randomx_hash(
    BigInt(height),
    BigInt(height),
    seedInput.byteOffset,
    input.byteOffset,
    blob.length,
    output.byteOffset
  );
}

// Main work loop (exactly like demo's wrapper.js)
function work() {
  const workStart = now();
  let hashes = 0;
  let ifMeetTarget = false;
  let interval = 0;
  
  // Hash for up to 1 second
  while (!ifMeetTarget && interval < 1000) {
    hashes += hash();
    ifMeetTarget = meetsTarget(output, target);
    interval = now() - workStart;
  }
  
  const hashesPerSecond = hashes / (interval / 1000);
  
  if (ifMeetTarget) {
    const nonce = bytesToHex(input.subarray(39, 43));
    const result = bytesToHex(output);
    console.log('[Worker] SHARE FOUND! nonce:', nonce);
    self.postMessage({
      hashesPerSecond: hashesPerSecond,
      hashes: hashes,
      job_id: currentJob.job_id,
      nonce: nonce,
      result: result
    });
  } else {
    self.postMessage({
      hashesPerSecond: hashesPerSecond,
      hashes: hashes
    });
  }
}

// Throttled work loop (for CPU limiting)
function workThrottled() {
  const workStart = now();
  hash();
  const workEnd = now();
  const interval = workEnd - workStart;
  throttledHashes++;
  
  const totalInterval = workEnd - throttledStart;
  const hashesPerSecond = throttledHashes / (totalInterval / 1000);
  
  if (meetsTarget(output, target)) {
    const nonce = bytesToHex(input.subarray(39, 43));
    const result = bytesToHex(output);
    console.log('[Worker] SHARE FOUND! nonce:', nonce);
    self.postMessage({
      hashesPerSecond: hashesPerSecond,
      hashes: throttledHashes,
      job_id: currentJob.job_id,
      nonce: nonce,
      result: result
    });
  } else if (totalInterval > 1000) {
    self.postMessage({
      hashesPerSecond: hashesPerSecond,
      hashes: throttledHashes
    });
  } else {
    setTimeout(workThrottled, Math.min(2000, interval * throttleWait));
  }
}

// Message handler (matches demo's wrapper.js onMessage)
self.onmessage = function(response) {
  const data = response.data;
  
  // If not ready yet, queue the job and wait
  if (!isReady) {
    console.log('[Worker] Not ready yet, queuing job:', data.job_id);
    pendingJob = data;
    return;
  }
  
  // Validate job data
  if (!data || !data.blob || !data.job_id) {
    console.log('[Worker] Invalid job data received');
    return;
  }
  
  // Check if new job
  if (!currentJob || currentJob.job_id !== data.job_id) {
    setJob(data);
  }
  
  // Start mining with or without throttle
  if (data.throttle) {
    throttleWait = 1 / (1 - data.throttle) - 1;
    throttledStart = now();
    throttledHashes = 0;
    workThrottled();
  } else {
    work();
  }
};

// Initialize on load
initModule();
`;
  }
  
  // ==========================================================================
  // MINE WORKER CLASS - Matches demo's mine-worker.js
  // ==========================================================================
  
  class MineWorker {
    constructor() {
      const code = createWorkerCode();
      const blob = new Blob([code], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      
      this.worker = new Worker(url);
      this.worker.onmessage = this.onReady.bind(this);
      this.currentJob = null;
      this.jobCallback = () => {};
      
      this._isReady = false;
      this.hashesPerSecond = 0;
      this.hashesTotal = 0;
      this.running = false;
      this.lastMessageTimestamp = Date.now();
    }
    
    onReady(response) {
      // Demo expects first message to be "ready" string
      if (response.data !== 'ready' && !this._isReady) {
        if (response.data.error) {
          console.error('[MineWorker] Init error:', response.data.error);
          return;
        }
      }
      
      if (response.data === 'ready') {
        console.log('[MineWorker] Worker is ready');
        this._isReady = true;
        this.worker.onmessage = this.onReceiveMsg.bind(this);
        if (this.currentJob) {
          this.running = true;
          this.worker.postMessage(this.currentJob);
        }
      }
    }
    
    onReceiveMsg(response) {
      // Check if share found
      if (response.data.result) {
        this.jobCallback(response.data);
      }
      
      // Update hashrate stats
      this.hashesPerSecond = 0.5 * this.hashesPerSecond + 0.5 * response.data.hashesPerSecond;
      this.hashesTotal += response.data.hashes;
      this.lastMessageTimestamp = Date.now();
      
      // Continue mining
      if (this.running && this.currentJob) {
        this.worker.postMessage(this.currentJob);
      }
    }
    
    setJob(job, callback) {
      this.currentJob = job;
      this.jobCallback = callback;
      if (this._isReady && !this.running) {
        this.running = true;
        this.worker.postMessage(this.currentJob);
      }
    }
    
    stop() {
      if (this.worker) {
        this.worker.terminate();
        this.worker = null;
      }
      this.running = false;
    }
  }
  
  // ==========================================================================
  // SHARE SUBMISSION
  // ==========================================================================
  
  function onTargetMet(shareData) {
    console.log('[Miner] SHARE FOUND! Submitting to pool...');
    
    totalHashes += shareData.hashes || 0;
    window.totalhashes = totalHashes;
    
    if (ws && ws.readyState === WebSocket.OPEN && currentJob) {
      if (shareData.job_id === currentJob.job_id) {
        const submitMsg = {
          type: 'submit',
          params: {
            job_id: shareData.job_id,
            nonce: shareData.nonce,
            result: shareData.result
          }
        };
        ws.send(JSON.stringify(submitMsg));
        console.log('[Miner] Share submitted:', shareData.nonce);
      }
    }
    
    if (typeof window.on_workermsg === 'function') {
      window.on_workermsg({ data: { type: 'found', ...shareData } }, 0);
    }
  }
  
  // ==========================================================================
  // HASHRATE MONITORING
  // ==========================================================================
  
  function getHashesPerSecond() {
    let sum = 0;
    for (let i = 0; i < mineWorkers.length; i++) {
      sum += mineWorkers[i].hashesPerSecond || 0;
    }
    return sum;
  }
  
  function getTotalHashes() {
    let sum = 0;
    for (let i = 0; i < mineWorkers.length; i++) {
      sum += mineWorkers[i].hashesTotal || 0;
    }
    window.totalhashes = sum;
    return sum;
  }
  
  // Update hashrate display every second
  setInterval(function() {
    if (isRunning) {
      const hashrate = getHashesPerSecond();
      getTotalHashes();
      if (hashrate > 0) {
        console.log('[Miner] Hashrate:', hashrate.toFixed(2), 'H/s, Total:', window.totalhashes);
      }
    }
  }, 5000);
  
  // ==========================================================================
  // WEBSOCKET CONNECTION TO PROXY
  // ==========================================================================
  
  function openWebSocket() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      console.log('[Miner] WebSocket already connected');
      return;
    }
    
    console.log('[Miner] Connecting to proxy:', config.proxy);
    ws = new WebSocket(config.proxy);
    window.ws = ws;
    
    ws.onopen = function() {
      console.log('[Miner] Connected to proxy!');
      
      // Authenticate with the pool
      const authMsg = {
        type: 'auth',
        params: {
          site_key: config.wallet,
          user: config.worker,
          algo: config.algo,
          pool: config.pool
        }
      };
      ws.send(JSON.stringify(authMsg));
      console.log('[Miner] Auth sent');
      
      if (typeof window.on_servermsg === 'function') {
        window.on_servermsg({ type: 'connected' });
      }
    };
    
    ws.onmessage = function(e) {
      try {
        const msg = JSON.parse(e.data);
        console.log('[Miner] Server message:', msg.type);
        
        if (msg.type === 'authed') {
          console.log('[Miner] Authenticated with pool!');
          if (typeof window.on_servermsg === 'function') {
            window.on_servermsg(msg);
          }
        } else if (msg.type === 'job') {
          // Store job and send to all workers
          currentJob = msg.params || msg;
          window.job = currentJob;
          console.log('[Miner] New job:', currentJob.job_id, 'seed:', currentJob.seed_hash?.substring(0, 16) + '...');
          
          // Distribute job to all workers
          for (let i = 0; i < mineWorkers.length; i++) {
            mineWorkers[i].setJob(currentJob, onTargetMet);
          }
          
          if (typeof window.on_servermsg === 'function') {
            window.on_servermsg(msg);
          }
        } else if (msg.type === 'hash_accepted' || msg.type === 'accepted') {
          acceptedHashes++;
          window.acceptedhashes = acceptedHashes;
          console.log('[Miner] Share accepted! Total accepted:', acceptedHashes);
          
          if (typeof window.on_servermsg === 'function') {
            window.on_servermsg({ type: 'accepted' });
          }
        } else if (msg.type === 'error') {
          console.error('[Miner] Pool error:', msg.params?.error || msg.error);
          if (typeof window.on_servermsg === 'function') {
            window.on_servermsg(msg);
          }
        }
      } catch (err) {
        console.error('[Miner] Error parsing message:', err);
      }
    };
    
    ws.onerror = function(err) {
      console.error('[Miner] WebSocket error:', err);
    };
    
    ws.onclose = function() {
      console.log('[Miner] WebSocket closed');
      
      // Reconnect after delay if still running
      if (isRunning) {
        reconnectTimeout = setTimeout(function() {
          console.log('[Miner] Reconnecting...');
          openWebSocket();
        }, 3000);
      }
    };
  }
  
  // ==========================================================================
  // MAIN API - Compatible with existing code
  // ==========================================================================
  
  // Start a new worker (called by knowingtogood)
  function knowingtogood() {
    if (!isRunning) {
      isRunning = true;
    }
    
    const mw = new MineWorker();
    mineWorkers.push(mw);
    
    // For compatibility, expose raw workers array
    window.workers = mineWorkers.map(m => m.worker);
    
    console.log('[Miner] Worker created, total:', mineWorkers.length);
    
    // If we have a job, set it on the new worker
    if (currentJob) {
      // Give worker time to init
      setTimeout(function() {
        mw.setJob(currentJob, onTargetMet);
      }, 2000);
    }
    
    // Call informWorker callback if exists
    if (typeof window.informWorker === 'function') {
      window.informWorker(mw.worker, mineWorkers.length - 1);
    }
    
    return mw.worker;
  }
  
  // Delete all workers
  function deleteAllWorkers() {
    console.log('[Miner] Stopping all workers...');
    isRunning = false;
    
    for (let i = 0; i < mineWorkers.length; i++) {
      try {
        mineWorkers[i].stop();
      } catch (e) {}
    }
    mineWorkers = [];
    window.workers = [];
    
    if (ws && ws.close) {
      ws.close();
    }
    ws = null;
    window.ws = null;
    
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
    }
    
    console.log('[Miner] All workers stopped');
  }
  
  // ==========================================================================
  // EXPORT GLOBALS
  // ==========================================================================
  
  window.openWebSocket = openWebSocket;
  window.knowingtogood = knowingtogood;
  window.deleteAllWorkers = deleteAllWorkers;
  window.getHashesPerSecond = getHashesPerSecond;
  window.getTotalHashes = getTotalHashes;
  
  console.log('[Miner] RandomX Miner v3.9.0 loaded (demo-compatible)');
  console.log('[Miner] Base URL:', BASE_URL);
  console.log('[Miner] Proxy:', config.proxy);
  console.log('[Miner] Pool:', config.pool);
  console.log('[Miner] Algo:', config.algo);
})();
