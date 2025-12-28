// RandomX Worker - Uses web-randomx.wasm for actual RandomX hashing
// This worker receives jobs and produces hashes

let Module = null;
let isReady = false;
let currentJob = null;
let throttle = 0;
let input = null;
let output = null;
let seedInput = null;
let target = new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255]);

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
}

function doHash(blobLength, height) {
  // Set random nonce
  const nonce = (4294967295 * Math.random() + 1) >>> 0;
  input[39] = (nonce >> 24) & 0xFF;
  input[40] = (nonce >> 16) & 0xFF;
  input[41] = (nonce >> 8) & 0xFF;
  input[42] = nonce & 0xFF;
  
  // Call RandomX hash function
  return Module._randomx_hash(
    BigInt(height || 0),
    BigInt(height || 0),
    seedInput.byteOffset,
    input.byteOffset,
    blobLength,
    output.byteOffset
  );
}

function work() {
  if (!isReady || !currentJob) {
    setTimeout(work, 100);
    return;
  }
  
  const workStart = performance.now();
  let hashes = 0;
  let foundShare = false;
  let interval = 0;
  const blobLength = hexToBytes(currentJob.blob).length;
  const height = currentJob.height || 0;
  
  // Mine for up to 1 second
  while (!foundShare && interval < 1000) {
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
    console.log('[Worker] Share found! Nonce:', nonce);
  } else {
    self.postMessage({
      type: 'hash',
      hashesPerSecond: hashesPerSecond,
      hashes: hashes
    });
  }
  
  // Continue mining (with throttle if set)
  if (throttle > 0) {
    setTimeout(work, throttle);
  } else {
    setTimeout(work, 10); // Small delay to not block
  }
}

// Message handler
self.onmessage = function(e) {
  const data = e.data;
  
  switch(data.type) {
    case 'job':
      if (data.job) {
        setJob(data.job);
        console.log('[Worker] New job received:', data.job.job_id);
        if (isReady) {
          work();
        }
      }
      break;
      
    case 'config':
      throttle = data.throttle || 0;
      console.log('[Worker] Config received, throttle:', throttle);
      break;
      
    case 'stop':
      currentJob = null;
      console.log('[Worker] Stopped');
      break;
      
    default:
      // Legacy format - direct job object
      if (data.blob && data.job_id) {
        setJob(data);
        if (isReady) {
          work();
        }
      }
  }
};

// Initialize on load
initModule();
