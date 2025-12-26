let running = false;
let intensity = 10; // Default to max
let engine = "CPU";
let wallet = "";
let pool = "";
let socket = null;
let jobId = null;

// rotating local challenge (no network)
let challenge = 0;
let target = 0x00000fff; // easy-ish
let lastRotate = 0;

// ---------- Stratum Protocol (Network) ----------
function connectPool() {
  if (!pool) return;
  try {
    console.log("Connecting to pool:", pool);
    socket = new WebSocket(pool);
    
    socket.onopen = () => {
      console.log("Connected to pool!");
      // Stratum Login
      const loginMsg = {
        "id": 1,
        "jsonrpc": "2.0",
        "method": "login",
        "params": {
          "login": wallet,
          "pass": "x",
          "agent": "web-miner/1.0"
        }
      };
      socket.send(JSON.stringify(loginMsg));
    };

    socket.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      console.log("Pool says:", msg);
      // In a real miner, we would parse the job here
      // msg.result.job or msg.params
    };

    socket.onerror = (e) => {
      console.error("Pool error:", e);
    };
    
    socket.onclose = () => {
      console.log("Pool connection closed");
      setTimeout(connectPool, 5000); // Reconnect
    };

  } catch (e) {
    console.error("Connection failed:", e);
  }
}

// ---------- toy 32-bit mix hash ----------
function mix32(x) {
  x >>>= 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}
function hash(ch, nonce) {
  return mix32((ch ^ nonce) >>> 0);
}
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function newChallenge(){
  challenge = (Math.random() * 0xffffffff) >>> 0;
  lastRotate = performance.now();
  postMessage({ type: "params", target });
}

// ---------------- WebGPU (optional) ----------------
let gpu = null;

async function initWebGPU(){
  if (!("gpu" in self.navigator)) return null;
  try {
    const adapter = await self.navigator.gpu.requestAdapter();
    if (!adapter) return null;
    const device = await adapter.requestDevice();

    const code = `
    struct Params { challenge:u32, target:u32, base:u32, count:u32 };
    @group(0) @binding(0) var<uniform> params : Params;

    struct Out { found: atomic<u32>, nonce: atomic<u32>, best: atomic<u32>, _pad: u32 };
    @group(0) @binding(1) var<storage, read_write> out : Out;

    fn mix32(x:u32) -> u32 {
      var y = x;
      y = y ^ (y >> 16u);
      y = y * 0x7feb352du;
      y = y ^ (y >> 15u);
      y = y * 0x846ca68bu;
      y = y ^ (y >> 16u);
      return y;
    }

    @compute @workgroup_size(256)
    fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
      let i = gid.x;
      if (i >= params.count) { return; }
      if (atomicLoad(&out.found) != 0u) { return; }

      let nonce = params.base + i;
      let h = mix32(nonce ^ params.challenge);

      if (h < params.target) {
        let res = atomicCompareExchangeWeak(&out.found, 0u, 1u);
        if (res.exchanged) {
          atomicStore(&out.nonce, nonce);
          atomicStore(&out.best, h);
        }
      }
    }
    `;

    const module = device.createShaderModule({ code });
    const pipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: "main" } });

    const uniformBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const outBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    const readBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: { buffer: outBuffer } }
      ]
    });

    device.queue.writeBuffer(outBuffer, 0, new Uint32Array([0,0,0,0]));
    return { device, pipeline, uniformBuffer, outBuffer, readBuffer, bindGroup };
  } catch (e) {
    console.error("WebGPU init failed:", e);
    return null;
  }
}

async function gpuLoop(){
  let base = (Math.random() * 0xffffffff) >>> 0;
  let lastT = performance.now();
  let hashesSince = 0;

  while (running && gpu) {
    const now = performance.now();
    if (now - lastRotate > 25_000) newChallenge();

    const level = Math.max(1, Math.min(10, intensity|0));
    const workgroups = 64 * level; // 64..640
    const count = workgroups * 256;

    gpu.device.queue.writeBuffer(gpu.uniformBuffer, 0, new Uint32Array([challenge, target, base, count]));
    gpu.device.queue.writeBuffer(gpu.outBuffer, 0, new Uint32Array([0,0,0,0]));

    const encoder = gpu.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(gpu.pipeline);
    pass.setBindGroup(0, gpu.bindGroup);
    pass.dispatchWorkgroups(workgroups);
    pass.end();

    encoder.copyBufferToBuffer(gpu.outBuffer, 0, gpu.readBuffer, 0, 16);
    gpu.device.queue.submit([encoder.finish()]);

    await gpu.readBuffer.mapAsync(GPUMapMode.READ);
    const data = new Uint32Array(gpu.readBuffer.getMappedRange()).slice();
    gpu.readBuffer.unmap();

    const found = data[0] >>> 0;

    hashesSince += count;
    const dt = (now - lastT) / 1000;
    const rate = dt > 0 ? hashesSince / dt : 0;

    postMessage({ type: "progress", hashesDelta: count, hashRate: rate, target });

    if (found) {
      postMessage({ type: "credit" });
      if (target > 0x000000ff) target = Math.max(0x000000ff, Math.floor(target * 0.90)) >>> 0;
      newChallenge();
      base = (base + count + 1) >>> 0;
      hashesSince = 0;
      lastT = performance.now();
      await sleep(30);
    } else {
      base = (base + count) >>> 0;
      await sleep(Math.max(0, 30 - level * 2));
      if (performance.now() - lastT > 900) { hashesSince = 0; lastT = performance.now(); }
    }
  }
}

// ---------------- WASM (optional) ----------------
let wasmInstance = null;

async function initWasm() {
  // Placeholder for WASM initialization
  // In a real scenario, we would fetch a .wasm file or instantiate from a byte array
  // const response = await fetch('miner.wasm');
  // const bytes = await response.arrayBuffer();
  // const { instance } = await WebAssembly.instantiate(bytes);
  // return instance;
  return null; // Currently disabled as we don't have the binary
}

async function wasmLoop() {
  // Placeholder loop
  // while (running && wasmInstance) { ... }
}

// ---------------- CPU (Fallback) ----------------
async function cpuLoop(){
  let nonce = (Math.random() * 0xffffffff) >>> 0;
  let lastT = performance.now();
  let hashesSince = 0;

  while (running && !gpu && !wasmInstance) {
    const now = performance.now();
    if (now - lastRotate > 25_000) newChallenge();

    const level = Math.max(1, Math.min(10, intensity|0));
    const batch = 30_000 * level;

    let found = false;
    for (let i=0; i<batch; i++) {
      const h = hash(challenge, nonce);
      if (h < target) { found = true; break; }
      nonce = (nonce + 1) >>> 0;
    }

    hashesSince += batch;
    const dt = (now - lastT) / 1000;
    const rate = dt > 0 ? hashesSince / dt : 0;

    postMessage({ type: "progress", hashesDelta: batch, hashRate: rate, target });

    if (found) {
      postMessage({ type: "credit" });
      if (target > 0x000000ff) target = Math.max(0x000000ff, Math.floor(target * 0.90)) >>> 0;
      newChallenge();
      hashesSince = 0;
      lastT = performance.now();
      await sleep(30);
    } else {
      await sleep(Math.max(0, 25 - level * 2));
      if (performance.now() - lastT > 900) { hashesSince = 0; lastT = performance.now(); }
    }
  }
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  if (msg.type === "start") {
    intensity = Number(msg.intensity) || 10;
    wallet = msg.wallet || "";
    pool = msg.pool || "";
    running = true;
    
    // Connect to the pool via proxy
    if (pool) connectPool();
    
    newChallenge();

    // Try WebGPU
    try { gpu = await initWebGPU(); } catch { gpu = null; }
    
    if (gpu) {
      engine = "WebGPU";
      postMessage({ type: "engine", value: engine });
      gpuLoop();
    } else {
      // Try WASM
      try { wasmInstance = await initWasm(); } catch { wasmInstance = null; }
      
      if (wasmInstance) {
        engine = "WASM";
        postMessage({ type: "engine", value: engine });
        wasmLoop();
      } else {
        // Fallback to CPU
        engine = "CPU (JS)";
        postMessage({ type: "engine", value: engine });
        cpuLoop();
      }
    }
  }
  if (msg.type === "setIntensity") intensity = Number(msg.intensity) || 10;
};
