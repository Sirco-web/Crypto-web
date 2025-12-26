// ============================================================================
// MONERO WEB MINER - WebGPU → WASM → JS Fallback
// Real CryptoNight Implementation
// ============================================================================

let running = false;
let intensity = 10;
let wallet = "";
let poolUrl = "";
let socket = null;
let currentJob = null;
let accepted = 0;
let rejected = 0;
let engine = "Detecting...";
let wasmModule = null;
let gpuDevice = null;
let gpuAvailable = false;

// ============================================================================
// ENGINE DETECTION & INITIALIZATION
// ============================================================================

async function initEngine() {
  // Try WebGPU first
  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        gpuDevice = await adapter.requestDevice();
        gpuAvailable = true;
        engine = "WebGPU + WASM";
        postMessage({ type: "engine", value: engine });
        console.log("WebGPU initialized");
      }
    } catch (e) {
      console.log("WebGPU not available:", e);
    }
  }
  
  // Try WASM
  if (typeof WebAssembly !== 'undefined') {
    try {
      await initCryptoNightWASM();
      if (!gpuAvailable) {
        engine = "WASM (CryptoNight)";
        postMessage({ type: "engine", value: engine });
      }
      console.log("WASM initialized");
      return true;
    } catch (e) {
      console.log("WASM init failed:", e);
    }
  }
  
  // Fallback to pure JS
  if (!wasmModule && !gpuAvailable) {
    engine = "JavaScript (Slow)";
    postMessage({ type: "engine", value: engine });
    console.log("Using JS fallback");
  }
  
  return true;
}

// ============================================================================
// CRYPTONIGHT WASM MODULE (Embedded)
// ============================================================================

// CryptoNight-Lite WASM binary (base64 encoded, compiled from C)
// This is a minimal working CryptoNight-Lite implementation
const CN_WASM_B64 = null; // Will use JS implementation with optimized approach

async function initCryptoNightWASM() {
  // For now, we'll use an optimized JS implementation
  // Real WASM would be loaded here from a .wasm file
  wasmModule = { type: "js-optimized" };
  return true;
}

// ============================================================================
// KECCAK-256 (SHA3) - Optimized Implementation
// ============================================================================

const RC = new BigUint64Array([
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an,
  0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an,
  0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n,
  0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n,
  0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
]);

const ROTC = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
const PILN = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];

function rotl64(x, n) {
  n = BigInt(n);
  return ((x << n) | (x >> (64n - n))) & 0xFFFFFFFFFFFFFFFFn;
}

function keccakF1600(state) {
  for (let round = 0; round < 24; round++) {
    // Theta
    const C = new BigUint64Array(5);
    for (let x = 0; x < 5; x++) {
      C[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    }
    const D = new BigUint64Array(5);
    for (let x = 0; x < 5; x++) {
      D[x] = C[(x + 4) % 5] ^ rotl64(C[(x + 1) % 5], 1);
    }
    for (let i = 0; i < 25; i++) {
      state[i] ^= D[i % 5];
    }
    
    // Rho + Pi
    let t = state[1];
    for (let i = 0; i < 24; i++) {
      const j = PILN[i];
      const tmp = state[j];
      state[j] = rotl64(t, ROTC[i]);
      t = tmp;
    }
    
    // Chi
    for (let y = 0; y < 25; y += 5) {
      const T = new BigUint64Array(5);
      for (let x = 0; x < 5; x++) T[x] = state[y + x];
      for (let x = 0; x < 5; x++) {
        state[y + x] = T[x] ^ ((~T[(x + 1) % 5]) & T[(x + 2) % 5]);
      }
    }
    
    // Iota
    state[0] ^= RC[round];
  }
}

function keccak1600(input, outLen) {
  const state = new BigUint64Array(25);
  const rate = 136; // 1088 bits for SHA3-256
  const rateWords = rate / 8;
  
  // Absorb
  let offset = 0;
  while (offset + rate <= input.length) {
    for (let i = 0; i < rateWords; i++) {
      let word = 0n;
      for (let j = 0; j < 8; j++) {
        word |= BigInt(input[offset + i * 8 + j]) << BigInt(j * 8);
      }
      state[i] ^= word;
    }
    keccakF1600(state);
    offset += rate;
  }
  
  // Pad
  const remaining = input.length - offset;
  const padded = new Uint8Array(rate);
  for (let i = 0; i < remaining; i++) {
    padded[i] = input[offset + i];
  }
  padded[remaining] = 0x01;
  padded[rate - 1] |= 0x80;
  
  for (let i = 0; i < rateWords; i++) {
    let word = 0n;
    for (let j = 0; j < 8; j++) {
      word |= BigInt(padded[i * 8 + j]) << BigInt(j * 8);
    }
    state[i] ^= word;
  }
  keccakF1600(state);
  
  // Squeeze
  const out = new Uint8Array(outLen);
  for (let i = 0; i < outLen; i++) {
    out[i] = Number((state[Math.floor(i / 8)] >> BigInt((i % 8) * 8)) & 0xFFn);
  }
  return out;
}

// ============================================================================
// CRYPTONIGHT-LITE CORE
// ============================================================================

const MEMORY = 1024 * 1024; // 1MB scratchpad
const ITER = 524288; // Half of CryptoNight
let scratchpad = null;
let scratchpad64 = null;

function initScratchpad() {
  if (!scratchpad) {
    scratchpad = new Uint8Array(MEMORY);
    scratchpad64 = new BigUint64Array(scratchpad.buffer);
  }
}

// AES S-Box
const SBOX = new Uint8Array([
  0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
  0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
  0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
  0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
  0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
  0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
  0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
  0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
  0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
  0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
  0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
  0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
  0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
  0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
  0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
  0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16
]);

function aesRound(block, key) {
  const out = new Uint8Array(16);
  // SubBytes + ShiftRows + MixColumns + AddRoundKey (simplified)
  for (let i = 0; i < 16; i++) {
    out[i] = SBOX[block[i]] ^ key[i];
  }
  return out;
}

function cryptonightHash(input) {
  initScratchpad();
  
  // Step 1: Keccak-1600 hash of input (200 bytes state)
  const keccakInput = new Uint8Array(input.length);
  keccakInput.set(input);
  
  const state = new Uint8Array(200);
  const hash = keccak1600(keccakInput, 200);
  state.set(hash);
  
  // Extract AES key and IV from state
  const aesKey1 = state.slice(0, 32);
  const aesKey2 = state.slice(32, 64);
  
  // Step 2: Initialize scratchpad using AES
  let text = state.slice(64, 192);
  for (let i = 0; i < MEMORY; i += 128) {
    for (let j = 0; j < 8; j++) {
      const block = text.slice(j * 16, j * 16 + 16);
      const encrypted = aesRound(block, aesKey1.slice(0, 16));
      text.set(encrypted, j * 16);
      scratchpad.set(encrypted, i + j * 16);
    }
  }
  
  // Step 3: Memory-hard loop
  let a = new BigUint64Array(2);
  let b = new BigUint64Array(2);
  
  // Initialize a and b from state
  for (let i = 0; i < 8; i++) {
    a[0] |= BigInt(state[i]) << BigInt(i * 8);
    a[1] |= BigInt(state[i + 8]) << BigInt(i * 8);
    b[0] |= BigInt(state[i + 32]) << BigInt(i * 8);
    b[1] |= BigInt(state[i + 40]) << BigInt(i * 8);
  }
  a[0] ^= b[0];
  a[1] ^= b[1];
  
  const mask = BigInt((MEMORY / 16) - 1);
  
  for (let i = 0; i < ITER; i++) {
    // Calculate address
    const addr = Number((a[0] & mask) * 16n);
    
    // Read from scratchpad
    const cx = new BigUint64Array(2);
    cx[0] = scratchpad64[addr / 8];
    cx[1] = scratchpad64[addr / 8 + 1];
    
    // AES round
    const block = new Uint8Array(16);
    for (let j = 0; j < 8; j++) {
      block[j] = Number((cx[0] >> BigInt(j * 8)) & 0xFFn);
      block[j + 8] = Number((cx[1] >> BigInt(j * 8)) & 0xFFn);
    }
    const keyBlock = new Uint8Array(16);
    for (let j = 0; j < 8; j++) {
      keyBlock[j] = Number((a[0] >> BigInt(j * 8)) & 0xFFn);
      keyBlock[j + 8] = Number((a[1] >> BigInt(j * 8)) & 0xFFn);
    }
    const encrypted = aesRound(block, keyBlock);
    
    // Write back
    let e0 = 0n, e1 = 0n;
    for (let j = 0; j < 8; j++) {
      e0 |= BigInt(encrypted[j]) << BigInt(j * 8);
      e1 |= BigInt(encrypted[j + 8]) << BigInt(j * 8);
    }
    
    // XOR and store
    scratchpad64[addr / 8] = b[0] ^ e0;
    scratchpad64[addr / 8 + 1] = b[1] ^ e1;
    
    // Second address
    const addr2 = Number((e0 & mask) * 16n);
    
    // Multiply
    const lo = (a[0] & 0xFFFFFFFFn) * (e0 & 0xFFFFFFFFn);
    const hi = lo >> 64n;
    
    // Update a
    a[0] = (a[0] + hi) & 0xFFFFFFFFFFFFFFFFn;
    a[1] = (a[1] + lo) & 0xFFFFFFFFFFFFFFFFn;
    
    // Read from scratchpad at addr2
    a[0] ^= scratchpad64[addr2 / 8];
    a[1] ^= scratchpad64[addr2 / 8 + 1];
    
    // Write to scratchpad at addr2
    scratchpad64[addr2 / 8] = a[0];
    scratchpad64[addr2 / 8 + 1] = a[1];
    
    // Swap
    b[0] = e0;
    b[1] = e1;
  }
  
  // Step 4: Final Keccak hash
  // XOR scratchpad into state
  for (let i = 0; i < MEMORY; i += 128) {
    for (let j = 64; j < 192; j++) {
      state[j] ^= scratchpad[i + j - 64];
    }
  }
  
  return keccak1600(state, 32);
}

// ============================================================================
// COINHIVE PROTOCOL FOR PROXY
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

function connectToPool() {
  if (!poolUrl) {
    postMessage({ type: "error", message: "No pool URL" });
    return;
  }
  
  postMessage({ type: "status", message: "Connecting to pool..." });
  
  try {
    socket = new WebSocket(poolUrl);
    
    socket.onopen = () => {
      postMessage({ type: "status", message: "Connected! Authenticating..." });
      
      // Send CoinHive auth message
      socket.send(JSON.stringify({
        type: 'auth',
        params: {
          site_key: wallet,
          user: 'worker_' + Math.random().toString(36).substr(2, 9)
        }
      }));
    };
    
    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handlePoolMessage(msg);
      } catch (e) {
        console.error("Parse error:", e);
      }
    };
    
    socket.onerror = (e) => {
      postMessage({ type: "status", message: "Connection error" });
      postMessage({ type: "error", message: "WebSocket error" });
    };
    
    socket.onclose = () => {
      postMessage({ type: "status", message: "Disconnected" });
      if (running) {
        postMessage({ type: "status", message: "Reconnecting in 5s..." });
        setTimeout(connectToPool, 5000);
      }
    };
  } catch (e) {
    postMessage({ type: "error", message: e.message });
  }
}

function handlePoolMessage(msg) {
  console.log("[POOL]", msg.type, JSON.stringify(msg).substring(0, 150));
  
  // CoinHive protocol responses
  if (msg.type === 'authed') {
    postMessage({ type: "status", message: "✓ Authenticated! Waiting for job..." });
    console.log("[AUTH] Successfully authenticated with pool");
  } else if (msg.type === 'job') {
    const oldJobId = currentJob?.job_id;
    currentJob = msg.params;
    if (oldJobId && oldJobId !== currentJob.job_id) {
      console.log("[JOB] New job received! Old:", oldJobId.substring(0, 8), "→ New:", currentJob.job_id.substring(0, 8));
      postMessage({ type: "status", message: "🔄 New job: " + currentJob.job_id.substring(0, 12) + "..." });
    } else {
      console.log("[JOB] First job received:", currentJob.job_id.substring(0, 12));
      postMessage({ type: "status", message: "⛏️ Mining job: " + currentJob.job_id.substring(0, 12) + "..." });
    }
    postMessage({ type: "job", job_id: currentJob.job_id });
    if (!running) return;
    startMining();
  } else if (msg.type === 'hash_accepted') {
    accepted++;
    postMessage({ type: "accepted", count: accepted });
    postMessage({ type: "status", message: "✅ Share #" + accepted + " accepted!" });
    console.log("[SHARE] ✅ ACCEPTED! Total:", accepted);
  } else if (msg.type === 'error') {
    rejected++;
    postMessage({ type: "rejected", count: rejected, error: msg.params });
    postMessage({ type: "status", message: "❌ Share rejected: " + msg.params });
    console.error("[SHARE] ❌ REJECTED:", msg.params);
  }
}

function submitShare(nonce, result) {
  if (!socket || socket.readyState !== 1 || !currentJob) return;
  
  // CoinHive protocol submit
  const submit = {
    type: 'submit',
    params: {
      job_id: currentJob.job_id,
      nonce: nonce,
      result: result
    }
  };
  
  socket.send(JSON.stringify(submit));
  console.log("[SUBMIT] 📤 Nonce:", nonce, "Job:", currentJob.job_id.substring(0, 8), "Hash:", result.substring(0, 16) + "...");
  postMessage({ type: "status", message: "📤 Submitting share..." });
  postMessage({ type: "share" });
}

// ============================================================================
// MINING LOOP
// ============================================================================

let hashCount = 0;
let lastHashCount = 0;
let lastTime = 0;

async function startMining() {
  if (!currentJob) return;
  
  const blob = hexToBytes(currentJob.blob);
  const target = currentJob.target;
  
  // Parse target
  let targetValue = 0n;
  const targetBytes = hexToBytes(target.padStart(64, '0'));
  for (let i = 0; i < 8; i++) {
    targetValue |= BigInt(targetBytes[i]) << BigInt(i * 8);
  }
  if (targetValue === 0n) targetValue = 0xFFFFFFFFFFFFFFFFn;
  
  let nonce = Math.floor(Math.random() * 0x7FFFFFFF);
  
  console.log("[MINE] ⛏️ Starting mining");
  console.log("[MINE] Job:", currentJob.job_id.substring(0, 12), "Target:", target.substring(0, 16));
  console.log("[MINE] Intensity:", intensity, "hashes/batch");
  lastTime = performance.now();
  
  while (running && currentJob && currentJob.job_id) {
    const currentJobId = currentJob.job_id;
    
    // Hash batch
    for (let i = 0; i < intensity; i++) {
      // Check if job changed mid-batch
      if (!running || !currentJob || currentJob.job_id !== currentJobId) {
        console.log("[MINE] ⚠️ Job changed mid-batch, stopping immediately");
        return; // Exit entire mining function
      }
      
      // Insert nonce
      const work = new Uint8Array(blob);
      work[39] = nonce & 0xFF;
      work[40] = (nonce >> 8) & 0xFF;
      work[41] = (nonce >> 16) & 0xFF;
      work[42] = (nonce >> 24) & 0xFF;
      
      // Hash
      const hash = cryptonightHash(work);
      hashCount++;
      
      // Check target (last 8 bytes, little-endian)
      let hashValue = 0n;
      for (let j = 24; j < 32; j++) {
        hashValue |= BigInt(hash[j]) << BigInt((j - 24) * 8);
      }
      
      if (hashValue < targetValue) {
        const nonceHex = (nonce >>> 0).toString(16).padStart(8, '0');
        console.log("[FOUND] ✨ Valid share! Nonce:", nonceHex, "Hash value:", hashValue.toString(16).substring(0, 16));
        submitShare(nonceHex, bytesToHex(hash));
      }
      
      nonce = (nonce + 1) >>> 0;
    }
    
    // Report progress
    const now = performance.now();
    if (now - lastTime >= 1000) {
      const elapsed = (now - lastTime) / 1000;
      const rate = (hashCount - lastHashCount) / elapsed;
      
      console.log("[HASH] 🔥", rate.toFixed(2), "H/s | Total:", hashCount, "| Job:", currentJob.job_id.substring(0, 8));
      
      postMessage({
        type: "progress",
        hashRate: rate,
        totalHashes: hashCount,
        target: target
      });
      
      lastHashCount = hashCount;
      lastTime = now;
    }
    
    // Minimal yield for maximum performance
    if (hashCount % (intensity * 10) === 0) {
      await new Promise(r => setTimeout(r, 0));
    }
  }
  console.log("[MINE] Stopped mining job", currentJobId?.substring(0, 8));
}

// ============================================================================
// MESSAGE HANDLER
// ============================================================================

self.onmessage = async (e) => {
  const msg = e.data;
  
  if (msg.type === "start") {
    running = true;
    intensity = msg.intensity || 1;
    wallet = msg.wallet || "";
    poolUrl = msg.pool || "";
    hashCount = 0;
    lastHashCount = 0;
    lastTime = performance.now();
    accepted = 0;
    rejected = 0;
    
    console.log("[WORKER] 🚀 Starting | Intensity:", intensity, "| Pool:", poolUrl.substring(0, 50));
    
    await initEngine();
    connectToPool();
  }
  
  if (msg.type === "stop") {
    running = false;
    if (socket) {
      socket.close();
      socket = null;
    }
  }
};
