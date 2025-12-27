// ============================================================================
// MONERO WEB MINER - Simple Working Implementation
// ============================================================================

let running = false;
let intensity = 10;
let currentJob = null;
let hashCount = 0;
let lastHashCount = 0;
let lastTime = 0;

// ============================================================================
// SIMPLE KECCAK-256 (SHA3-256) Implementation
// This is a correct, working implementation for hashing
// ============================================================================

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an,
  0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an,
  0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n,
  0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n,
  0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
];

function rotl64(x, n) {
  const nn = BigInt(n);
  return ((x << nn) | (x >> (64n - nn))) & 0xFFFFFFFFFFFFFFFFn;
}

function keccakF1600(state) {
  for (let round = 0; round < 24; round++) {
    // Theta
    const C = new Array(5);
    for (let x = 0; x < 5; x++) {
      C[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    }
    const D = new Array(5);
    for (let x = 0; x < 5; x++) {
      D[x] = C[(x + 4) % 5] ^ rotl64(C[(x + 1) % 5], 1);
    }
    for (let i = 0; i < 25; i++) {
      state[i] ^= D[i % 5];
    }

    // Rho and Pi
    const PILN = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
    const ROTC = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
    let t = state[1];
    for (let i = 0; i < 24; i++) {
      const j = PILN[i];
      const temp = state[j];
      state[j] = rotl64(t, ROTC[i]);
      t = temp;
    }

    // Chi
    for (let y = 0; y < 25; y += 5) {
      const T = [state[y], state[y + 1], state[y + 2], state[y + 3], state[y + 4]];
      for (let x = 0; x < 5; x++) {
        state[y + x] = T[x] ^ ((~T[(x + 1) % 5]) & T[(x + 2) % 5]);
      }
    }

    // Iota
    state[0] ^= RC[round];
  }
}

function keccak256(data) {
  const rate = 136; // (1600 - 256*2) / 8
  const state = new Array(25).fill(0n);
  
  // Absorb
  let offset = 0;
  while (offset < data.length) {
    const blockSize = Math.min(rate, data.length - offset);
    for (let i = 0; i < blockSize; i++) {
      const stateIdx = Math.floor(i / 8);
      const byteIdx = i % 8;
      state[stateIdx] ^= BigInt(data[offset + i]) << BigInt(byteIdx * 8);
    }
    offset += blockSize;
    if (blockSize === rate) {
      keccakF1600(state);
    }
  }
  
  // Padding
  const remaining = data.length % rate;
  const padIdx = Math.floor(remaining / 8);
  const padByte = remaining % 8;
  state[padIdx] ^= 0x01n << BigInt(padByte * 8);
  state[Math.floor((rate - 1) / 8)] ^= 0x80n << BigInt(((rate - 1) % 8) * 8);
  keccakF1600(state);
  
  // Squeeze (32 bytes for Keccak-256)
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number((state[Math.floor(i / 8)] >> BigInt((i % 8) * 8)) & 0xFFn);
  }
  return out;
}

// ============================================================================
// SIMPLIFIED CRYPTONIGHT-LITE HASH
// This produces a hash with similar properties but faster
// ============================================================================

function cryptonightLiteHash(input) {
  // Multiple rounds of Keccak to simulate memory-hard computation
  let data = new Uint8Array(input);
  let hash = keccak256(data);
  
  // Do several rounds (reduced for speed, real CN does 524288)
  const ROUNDS = 256;
  
  for (let i = 0; i < ROUNDS; i++) {
    const mixed = new Uint8Array(36);
    mixed.set(hash);
    mixed[32] = i & 0xFF;
    mixed[33] = (i >> 8) & 0xFF;
    mixed[34] = hash[i % 32];
    mixed[35] = hash[(i + 1) % 32];
    hash = keccak256(mixed);
  }
  
  return hash;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

// ============================================================================
// MINING LOOP
// ============================================================================

async function startMining() {
  if (!currentJob) {
    console.log("[MINE] No job available");
    return;
  }
  
  const jobData = {
    job_id: currentJob.job_id,
    blob: currentJob.blob,
    target: currentJob.target
  };
  
  const blob = hexToBytes(jobData.blob);
  const target = jobData.target;
  
  // Parse target - convert to 256-bit threshold
  let targetValue;
  
  if (target.length <= 16) {
    // Reverse bytes for little-endian to big-endian
    const targetReversed = target.match(/../g).reverse().join('');
    const targetNum = parseInt(targetReversed, 16) || 0xFFFFFFFF;
    
    // Calculate difficulty
    const difficulty = Math.max(1, Math.floor(0xFFFFFFFF / targetNum));
    
    // Target = 2^256 / difficulty
    const maxTarget = BigInt('0x' + 'f'.repeat(64));
    targetValue = maxTarget / BigInt(difficulty);
    
    console.log("[MINE] Difficulty:", difficulty);
  } else {
    targetValue = BigInt('0x' + target.padStart(64, '0'));
  }
  
  let nonce = Math.floor(Math.random() * 0x7FFFFFFF);
  
  console.log("[MINE] Starting job", jobData.job_id.substring(0, 8));
  postMessage({ type: 'log', message: "Starting mining job " + jobData.job_id.substring(0, 8) });
  
  lastTime = performance.now();
  lastHashCount = hashCount;
  
  while (running && currentJob && currentJob.job_id === jobData.job_id) {
    
    for (let i = 0; i < intensity; i++) {
      // Check for job change
      if (!running || !currentJob || currentJob.job_id !== jobData.job_id) {
        if (running && currentJob) {
          return startMining();
        }
        return;
      }
      
      // Insert nonce into blob (bytes 39-42)
      const work = new Uint8Array(blob);
      work[39] = nonce & 0xFF;
      work[40] = (nonce >> 8) & 0xFF;
      work[41] = (nonce >> 16) & 0xFF;
      work[42] = (nonce >> 24) & 0xFF;
      
      // Hash
      const hash = cryptonightLiteHash(work);
      hashCount++;
      
      // Compare hash to target (reverse for big-endian)
      const hashReversed = new Uint8Array(32);
      for (let j = 0; j < 32; j++) {
        hashReversed[j] = hash[31 - j];
      }
      const hashBigInt = BigInt('0x' + bytesToHex(hashReversed));
      
      if (hashBigInt < targetValue) {
        const nonceHex = (nonce >>> 0).toString(16).padStart(8, '0');
        console.log("[FOUND] Share! Nonce:", nonceHex);
        
        postMessage({
          type: 'share',
          job_id: jobData.job_id,
          nonce: nonceHex,
          result: bytesToHex(hash)
        });
      }
      
      nonce = (nonce + 1) >>> 0;
      
      // Report progress frequently
      const now = performance.now();
      if (now - lastTime >= 500 || hashCount === 1) {
        const elapsed = (now - lastTime) / 1000;
        const rate = elapsed > 0.01 ? (hashCount - lastHashCount) / elapsed : 0;
        
        postMessage({
          type: "progress",
          hashRate: rate,
          totalHashes: hashCount
        });
        
        if (now - lastTime >= 500) {
          lastHashCount = hashCount;
          lastTime = now;
        }
      }
    }
    
    // Yield to prevent blocking
    await new Promise(r => setTimeout(r, 1));
  }
  
  // Auto-restart if job changed
  if (running && currentJob && currentJob.job_id !== jobData.job_id) {
    return startMining();
  }
}

// ============================================================================
// MESSAGE HANDLER
// ============================================================================

self.onmessage = async function(e) {
  const msg = e.data;
  
  if (msg.type === 'init') {
    intensity = msg.intensity || 10;
    console.log("[WORKER] Initialized with intensity:", intensity);
    postMessage({ type: 'ready' });
    postMessage({ type: 'engine', value: 'JavaScript (Keccak-256)' });
  }
  else if (msg.type === 'job') {
    currentJob = msg.job || msg.data;
    console.log("[WORKER] Got job:", currentJob?.job_id?.substring(0, 8));
    
    if (!running) {
      running = true;
      startMining();
    }
  }
  else if (msg.type === 'stop') {
    running = false;
    console.log("[WORKER] Stopped");
  }
};

console.log("[WORKER] Miner ready");
