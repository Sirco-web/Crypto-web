// =============================================================================
// RANDOMX WEB MINER v3.8.0 - Production Ready
// =============================================================================
// Uses compiled web-randomx.wasm for actual RandomX hashing
// Replaces the broken perfektweb.js with working implementation
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
  let workers = [];
  let currentJob = null;
  let totalHashes = 0;
  let acceptedHashes = 0;
  let currentHashrate = 0;
  let isRunning = false;
  let reconnectTimeout = null;
  
  // Export globals for compatibility
  window.ws = null;
  window.workers = [];
  window.totalhashes = 0;
  window.acceptedhashes = 0;
  window.job = null;
  
  // ==========================================================================
  // WORKER CREATION - Inline worker with web-randomx.wasm
  // ==========================================================================
  
  function createWorkerCode() {
    return `
// RandomX Worker - Uses web-randomx.wasm for actual RandomX hashing
let Module = null;
let isReady = false;
let currentJob = null;
let throttle = 0;
let input = null;
let output = null;
let seedInput = null;
let target = new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255]);
let shouldStop = false;

// Initialize WASM module
async function initModule() {
  try {
    // Load web-randomx.js (Emscripten module)
    importScripts('web-randomx.js');
    
    Module = await self.Module({
      locateFile(path) {
        if (path.endsWith('.wasm')) {
          return 'web-randomx.wasm';
        }
        return path;
      }
    });
    
    // Allocate memory buffers
    input = new Uint8Array(Module.HEAPU8.buffer, Module._malloc(256), 256);
    output = new Uint8Array(Module.HEAPU8.buffer, Module._malloc(32), 32);
    seedInput = new Uint8Array(Module.HEAPU8.buffer, Module._malloc(32), 32);
    
    isReady = true;
    self.postMessage({ type: 'ready' });
    console.log('[Worker] RandomX WASM module initialized');
  } catch (error) {
    console.error('[Worker] Failed to initialize WASM:', error);
    self.postMessage({ type: 'error', error: error.message });
  }
}

// Helper functions
function hexToBytes(hex) {
  const len = hex.length / 2;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; ++i) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; ++i) {
    hex += (bytes[i] >>> 4).toString(16);
    hex += (15 & bytes[i]).toString(16);
  }
  return hex;
}

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

function setJob(data) {
  currentJob = data;
  const blob = hexToBytes(data.blob);
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
  
  if (data.seed_hash) {
    const seedBlob = hexToBytes(data.seed_hash);
    seedInput.set(seedBlob);
  }
  
  console.log('[Worker] Job set:', data.job_id, 'target:', data.target);
}

function doHash(blobLength, height) {
  // Set random nonce
  const nonce = (4294967295 * Math.random() + 1) >>> 0;
  input[39] = (nonce >> 24) & 0xFF;
  input[40] = (nonce >> 16) & 0xFF;
  input[41] = (nonce >> 8) & 0xFF;
  input[42] = nonce & 0xFF;
  
  // Call RandomX hash function
  try {
    return Module._randomx_hash(
      BigInt(height || 0),
      BigInt(height || 0),
      seedInput.byteOffset,
      input.byteOffset,
      blobLength,
      output.byteOffset
    );
  } catch (e) {
    console.error('[Worker] Hash error:', e);
    return 1;  // Return 1 hash counted even on error
  }
}

function work() {
  if (!isReady || !currentJob || shouldStop) {
    if (!shouldStop) setTimeout(work, 100);
    return;
  }
  
  const workStart = performance.now();
  let hashes = 0;
  let foundShare = false;
  let interval = 0;
  const blobLength = hexToBytes(currentJob.blob).length;
  const height = currentJob.height || 0;
  
  // Mine for up to 1 second
  while (!foundShare && interval < 1000 && !shouldStop) {
    hashes += doHash(blobLength, height);
    foundShare = meetsTarget(output, target);
    interval = performance.now() - workStart;
  }
  
  const hashesPerSecond = hashes / (interval / 1000);
  
  if (foundShare) {
    const nonce = bytesToHex(input.subarray(39, 43));
    const result = bytesToHex(output);
    self.postMessage({
      type: 'found',
      hashesPerSecond: hashesPerSecond,
      hashes: hashes,
      job_id: currentJob.job_id,
      nonce: nonce,
      result: result
    });
    console.log('[Worker] SHARE FOUND! Nonce:', nonce, 'Result:', result.substring(0, 16) + '...');
  } else {
    self.postMessage({
      type: 'hash',
      hashesPerSecond: hashesPerSecond,
      hashes: hashes
    });
  }
  
  // Continue mining
  if (!shouldStop) {
    if (throttle > 0) {
      setTimeout(work, throttle);
    } else {
      setTimeout(work, 10);
    }
  }
}

// Message handler
self.onmessage = function(e) {
  const data = e.data;
  
  switch(data.type) {
    case 'job':
      if (data.job) {
        setJob(data.job);
        shouldStop = false;
        if (isReady) {
          work();
        }
      }
      break;
      
    case 'config':
      throttle = data.throttle || 0;
      break;
      
    case 'stop':
      shouldStop = true;
      currentJob = null;
      break;
      
    default:
      // Legacy format - direct job object
      if (data.blob && data.job_id) {
        setJob(data);
        shouldStop = false;
        if (isReady) {
          work();
        }
      }
  }
};

// Initialize on load
initModule();
`;
  }
  
  function createWorker() {
    const code = createWorkerCode();
    const blob = new Blob([code], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    
    worker.onmessage = function(e) {
      const data = e.data;
      
      if (data.type === 'ready') {
        console.log('[Miner] Worker ready');
        if (currentJob) {
          worker.postMessage({ type: 'job', job: currentJob });
        }
      } else if (data.type === 'hash') {
        totalHashes += data.hashes || 0;
        currentHashrate = data.hashesPerSecond || 0;
        window.totalhashes = totalHashes;
        if (typeof window.on_workermsg === 'function') {
          window.on_workermsg({ data: data }, workers.indexOf(worker));
        }
      } else if (data.type === 'found') {
        console.log('[Miner] SHARE FOUND! Submitting...');
        totalHashes += data.hashes || 0;
        currentHashrate = data.hashesPerSecond || 0;
        window.totalhashes = totalHashes;
        
        // Submit share to pool
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'submit',
            params: {
              job_id: data.job_id,
              nonce: data.nonce,
              result: data.result
            }
          }));
          console.log('[Miner] Share submitted:', data.nonce);
        }
        
        if (typeof window.on_workermsg === 'function') {
          window.on_workermsg({ data: data }, workers.indexOf(worker));
        }
      } else if (data.type === 'error') {
        console.error('[Miner] Worker error:', data.error);
      }
    };
    
    worker.onerror = function(e) {
      console.error('[Miner] Worker error:', e.message);
    };
    
    workers.push(worker);
    window.workers = workers;
    return worker;
  }
  
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
          console.log('[Miner] New job:', currentJob.job_id);
          
          for (let i = 0; i < workers.length; i++) {
            workers[i].postMessage({ type: 'job', job: currentJob });
          }
          
          if (typeof window.on_servermsg === 'function') {
            window.on_servermsg(msg);
          }
        } else if (msg.type === 'hash_accepted' || msg.type === 'accepted') {
          acceptedHashes++;
          window.acceptedhashes = acceptedHashes;
          console.log('[Miner] Share accepted! Total:', acceptedHashes);
          
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
    
    const worker = createWorker();
    console.log('[Miner] Worker created, total:', workers.length);
    
    // Call informWorker callback if exists
    if (typeof window.informWorker === 'function') {
      window.informWorker(worker, workers.length - 1);
    }
    
    return worker;
  }
  
  // Delete all workers
  function deleteAllWorkers() {
    console.log('[Miner] Stopping all workers...');
    isRunning = false;
    
    for (let i = 0; i < workers.length; i++) {
      try {
        workers[i].postMessage({ type: 'stop' });
        workers[i].terminate();
      } catch (e) {}
    }
    workers = [];
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
  
  console.log('[Miner] RandomX Miner v3.8.0 loaded');
  console.log('[Miner] Proxy:', config.proxy);
  console.log('[Miner] Pool:', config.pool);
  console.log('[Miner] Algo:', config.algo);
})();
