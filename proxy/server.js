// =============================================================================
// XMR MINING PROXY SERVER - Production Ready (Render/Koyeb/etc)
// =============================================================================
// Combines ALL browser miners into ONE powerful pool worker
// All connected miners share the same pool connection = combined hashpower!
// =============================================================================

const net = require('net');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// =============================================================================
// CONFIGURATION - Edit these or use environment variables!
// =============================================================================
const CONFIG = {
  // Server
  port: process.env.PORT || 8892,
  
  // Owner PIN for admin panel (CHANGE THIS!)
  ownerPin: process.env.OWNER_PIN || '1234',
  
  // Pool settings
  pool: {
    host: process.env.POOL_HOST || 'gulf.moneroocean.stream',
    port: parseInt(process.env.POOL_PORT) || 10128,
    wallet: process.env.WALLET || '47ocfRVLCp71ZtNvdrxtAR85VDbNdmUMph5mNWfRf3z2FuRhPFJVm7cReXjM1i1sZmE4vsLWd32BvNSUhP5NQjwmR1zGTuL',
    workerName: process.env.WORKER_NAME || 'sirco-sub-pool-miners',
    difficulty: parseInt(process.env.DIFFICULTY) || 128000
  },
  
  // Paths
  publicPath: path.join(__dirname, '..'),
  libPath: path.join(__dirname, '..', 'lib')
};

// Get pool password with current difficulty
function getPoolPassword() {
  return `x:fixed_diff_${CONFIG.pool.difficulty}`;
}

// =============================================================================
// SECURITY - Rate limiting and session tokens
// =============================================================================
const security = {
  failedAttempts: new Map(),  // IP -> { count, lastAttempt }
  sessions: new Map(),  // token -> { created, ip }
  maxAttempts: 5,
  lockoutTime: 300000,  // 5 minutes
  sessionTimeout: 3600000  // 1 hour
};

function generateToken() {
  return require('crypto').randomBytes(32).toString('hex');
}

function checkRateLimit(ip) {
  const record = security.failedAttempts.get(ip);
  if (!record) return true;
  
  if (Date.now() - record.lastAttempt > security.lockoutTime) {
    security.failedAttempts.delete(ip);
    return true;
  }
  
  return record.count < security.maxAttempts;
}

function recordFailedAttempt(ip) {
  const record = security.failedAttempts.get(ip) || { count: 0, lastAttempt: 0 };
  record.count++;
  record.lastAttempt = Date.now();
  security.failedAttempts.set(ip, record);
  console.log(`[Security] Failed login from ${ip} (${record.count}/${security.maxAttempts})`);
}

function createSession(ip) {
  const token = generateToken();
  security.sessions.set(token, { created: Date.now(), ip });
  return token;
}

function validateSession(token, ip) {
  const session = security.sessions.get(token);
  if (!session) return false;
  if (Date.now() - session.created > security.sessionTimeout) {
    security.sessions.delete(token);
    return false;
  }
  return session.ip === ip;
}

// Cleanup old sessions every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of security.sessions) {
    if (now - session.created > security.sessionTimeout) {
      security.sessions.delete(token);
    }
  }
  for (const [ip, record] of security.failedAttempts) {
    if (now - record.lastAttempt > security.lockoutTime) {
      security.failedAttempts.delete(ip);
    }
  }
}, 600000);

// =============================================================================
// GLOBAL STATS - Combined stats for ALL miners
// =============================================================================
const globalStats = {
  startTime: Date.now(),
  
  // Connections
  totalConnections: 0,
  activeMiners: new Map(), // id -> { ip, hashrate, hashes, connected }
  
  // Mining stats
  totalHashes: 0,
  totalShares: 0,
  acceptedShares: 0,
  rejectedShares: 0,
  blocksFound: 0,
  
  // Current combined hashrate (calculated from all miners)
  get combinedHashrate() {
    let total = 0;
    for (const miner of this.activeMiners.values()) {
      total += miner.hashrate || 0;
    }
    return total;
  },
  
  // Uptime
  get uptime() {
    return Math.floor((Date.now() - this.startTime) / 1000);
  }
};

// =============================================================================
// SHARED POOL CONNECTION - All miners use this single connection
// =============================================================================
let sharedPool = null;
let poolConnected = false;
let poolAuthenticated = false;  // TRUE only after pool sends first job response
let poolWorkerId = null;  // Session ID from pool - MUST use this for submits!
let poolBuffer = '';
let currentJob = null;
let recentJobs = new Map();  // job_id -> job (keep last 10 jobs for slow miners)
const MAX_RECENT_JOBS = 10;
let minerId = 0;

function connectToPool() {
  if (sharedPool) return;
  
  console.log(`[Pool] Connecting to ${CONFIG.pool.host}:${CONFIG.pool.port}...`);
  
  sharedPool = new net.Socket();
  
  sharedPool.connect(CONFIG.pool.port, CONFIG.pool.host, () => {
    console.log('[Pool] TCP Connected, sending login...');
    poolConnected = true;
    poolAuthenticated = false;  // Not authenticated until we get job response
    currentJob = null;  // Clear old job on reconnect
    
    // Login with combined worker name and difficulty
    const loginMsg = {
      id: 1,
      method: 'login',
      params: {
        login: CONFIG.pool.wallet,
        pass: getPoolPassword(),  // Uses current difficulty setting
        agent: 'CombinedWebMiner/2.0'
      }
    };
    sharedPool.write(JSON.stringify(loginMsg) + '\n');
    console.log(`[Pool] Sent login - Worker: ${CONFIG.pool.workerName}, Difficulty: ${CONFIG.pool.difficulty}`);
  });
  
  sharedPool.on('data', (data) => {
    poolBuffer += data.toString();
    const lines = poolBuffer.split('\n');
    poolBuffer = lines.pop();
    
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        handlePoolMessage(msg);
      } catch (e) {
        console.error('[Pool] Parse error:', e.message);
      }
    }
  });
  
  sharedPool.on('error', (err) => {
    console.error('[Pool] Error:', err.message);
    poolConnected = false;
    poolAuthenticated = false;
    poolWorkerId = null;
    currentJob = null;
    recentJobs.clear();  // Clear old jobs on error
  });
  
  sharedPool.on('close', () => {
    console.log('[Pool] Disconnected, reconnecting in 5s...');
    poolConnected = false;
    poolAuthenticated = false;
    poolWorkerId = null;
    currentJob = null;
    recentJobs.clear();  // Clear old jobs on disconnect
    sharedPool = null;
    setTimeout(connectToPool, 5000);
  });
}

function handlePoolMessage(msg) {
  // Login response with job
  if (msg.id === 1 && msg.result && msg.result.job) {
    // CRITICAL: Save the worker ID from pool - we MUST use this for all submits!
    poolWorkerId = msg.result.id;
    console.log('[Pool] ✅ Authenticated! Worker ID:', poolWorkerId);
    console.log('[Pool] Job target (difficulty):', msg.result.job.target);
    poolAuthenticated = true;  // NOW we are truly ready
    currentJob = msg.result.job;
    addRecentJob(currentJob);
    broadcastToMiners({ type: 'authed', params: { hashes: 0 } });
    broadcastJob(currentJob);
  }
  // New job from pool
  else if (msg.method === 'job') {
    console.log('[Pool] New job received, target:', msg.params.target);
    currentJob = msg.params;
    addRecentJob(currentJob);
    broadcastJob(currentJob);
  }
  // Share accepted
  else if (msg.id && msg.result && msg.result.status === 'OK') {
    globalStats.acceptedShares++;
    console.log(`[Pool] ✅ Share accepted! Total: ${globalStats.acceptedShares}`);
    // Notify all miners
    broadcastToMiners({ type: 'hash_accepted', params: { hashes: 1 } });
  }
  // Error
  else if (msg.id && msg.error) {
    globalStats.rejectedShares++;
    console.log('[Pool] ❌ Share rejected:', msg.error.message);
    broadcastToMiners({ type: 'error', params: { error: msg.error.message } });
  }
}

// Reconnect to pool (used when settings change)
function reconnectPool() {
  if (sharedPool) {
    sharedPool.destroy();
    sharedPool = null;
  }
  poolConnected = false;
  poolAuthenticated = false;
  currentJob = null;
  recentJobs.clear();
  setTimeout(connectToPool, 1000);
}

function broadcastJob(job) {
  if (!job) return;
  const msg = {
    type: 'job',
    params: {
      job_id: job.job_id,
      blob: job.blob,
      target: job.target
    }
  };
  broadcastToMiners(msg);
}

function broadcastToMiners(msg) {
  const data = JSON.stringify(msg);
  for (const [id, miner] of globalStats.activeMiners) {
    if (miner.ws && miner.ws.readyState === WebSocket.OPEN) {
      miner.ws.send(data);
    }
  }
}

// Add job to recent jobs list
function addRecentJob(job) {
  if (!job || !job.job_id) return;
  recentJobs.set(job.job_id, job);
  // Keep only the last MAX_RECENT_JOBS
  if (recentJobs.size > MAX_RECENT_JOBS) {
    const firstKey = recentJobs.keys().next().value;
    recentJobs.delete(firstKey);
  }
}

function submitToPool(params) {
  if (!sharedPool || !sharedPool.writable) {
    console.log('[Pool] Cannot submit - not connected');
    return false;
  }
  
  if (!poolAuthenticated || !poolWorkerId) {
    console.log('[Pool] Cannot submit - not authenticated yet (no worker ID)');
    return false;
  }
  
  // Check if this share is for a RECENT job (allow slightly stale shares)
  if (!recentJobs.has(params.job_id)) {
    console.log('[Pool] ⚠️ Rejecting VERY OLD share - job_id not in recent list');
    console.log(`[Pool]    Share job_id: ${params.job_id}`);
    return false;
  }
  
  // Log if it's not the current job but still valid
  if (currentJob && params.job_id !== currentJob.job_id) {
    console.log('[Pool] 📤 Submitting slightly stale share (still in recent jobs)');
  }
  
  console.log('[Pool] Submitting share:', JSON.stringify(params));
  
  const msg = {
    id: Date.now(),
    method: 'submit',
    params: {
      id: poolWorkerId,  // Use the session ID from pool login!
      job_id: params.job_id,
      nonce: params.nonce,
      result: params.result
    }
  };
  
  console.log('[Pool] Submit message:', JSON.stringify(msg));
  sharedPool.write(JSON.stringify(msg) + '\n');
  globalStats.totalShares++;
  return true;
}

// =============================================================================
// MIME TYPES
// =============================================================================
const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.mem': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml'
};

// =============================================================================
// CORS MIDDLEWARE
// =============================================================================
function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

// =============================================================================
// HTTP SERVER
// =============================================================================
const server = http.createServer((req, res) => {
  setCorsHeaders(res);
  
  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = url.pathname;
  
  // ==========================================================================
  // API ENDPOINTS
  // ==========================================================================
  
  // ROOT = Stats Dashboard (port 8892 is the PROXY, not the mining site!)
  if (pathname === '/' || pathname === '/index.html') {
    res.setHeader('Content-Type', 'text/html');
    res.writeHead(200);
    res.end(generateDashboardHTML());
    return;
  }
  
  // Stats API (JSON)
  if (pathname === '/api/stats') {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    
    const miners = [];
    for (const [id, miner] of globalStats.activeMiners) {
      miners.push({
        id,
        ip: miner.ip,
        hashrate: miner.hashrate,
        hashes: miner.hashes,
        connected: miner.connected,
        workerType: miner.workerType,
        cores: miner.cores,
        threads: miner.threads,
        throttle: miner.throttle,
        status: miner.status
      });
    }
    
    res.end(JSON.stringify({
      server: {
        uptime: globalStats.uptime,
        uptimeFormatted: formatUptime(globalStats.uptime)
      },
      pool: {
        host: CONFIG.pool.host,
        connected: poolConnected,
        wallet: CONFIG.pool.wallet.slice(0, 8) + '...' + CONFIG.pool.wallet.slice(-8),
        workerName: CONFIG.pool.workerName
      },
      mining: {
        combinedHashrate: globalStats.combinedHashrate,
        totalHashes: globalStats.totalHashes,
        totalShares: globalStats.totalShares,
        acceptedShares: globalStats.acceptedShares,
        rejectedShares: globalStats.rejectedShares,
        blocksFound: globalStats.blocksFound
      },
      miners: {
        active: globalStats.activeMiners.size,
        totalConnections: globalStats.totalConnections,
        list: miners
      }
    }));
    return;
  }
  
  // Health check
  if (pathname === '/health') {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', uptime: globalStats.uptime }));
    return;
  }
  
  // ==========================================================================
  // OWNER PANEL - Protected by PIN with rate limiting and sessions
  // ==========================================================================
  const clientIP = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
                   req.socket.remoteAddress || 'unknown';
  
  if (pathname === '/owner') {
    res.setHeader('Content-Type', 'text/html');
    res.writeHead(200);
    res.end(generateOwnerLoginHTML());
    return;
  }
  
  // Login endpoint - creates session token
  if (pathname === '/owner/login') {
    const pin = url.searchParams.get('pin');
    
    // Check rate limit
    if (!checkRateLimit(clientIP)) {
      res.setHeader('Content-Type', 'text/html');
      res.writeHead(429);
      res.end('<html><body style="background:#1a1a2e;color:#ff6b6b;font-family:monospace;padding:50px;text-align:center;"><h1>🔒 Too Many Attempts</h1><p>Please wait 5 minutes before trying again.</p><a href="/owner" style="color:#4ecdc4;">Back</a></body></html>');
      return;
    }
    
    if (pin !== CONFIG.ownerPin) {
      recordFailedAttempt(clientIP);
      res.setHeader('Content-Type', 'text/html');
      res.writeHead(403);
      res.end('<html><body style="background:#1a1a2e;color:#ff6b6b;font-family:monospace;padding:50px;text-align:center;"><h1>❌ Invalid PIN</h1><a href="/owner" style="color:#4ecdc4;">Try Again</a></body></html>');
      return;
    }
    
    // Create session token
    const token = createSession(clientIP);
    res.setHeader('Content-Type', 'text/html');
    res.writeHead(302, { 'Location': `/owner/panel?token=${token}` });
    res.end();
    return;
  }
  
  if (pathname === '/owner/panel') {
    const token = url.searchParams.get('token');
    if (!validateSession(token, clientIP)) {
      res.setHeader('Content-Type', 'text/html');
      res.writeHead(403);
      res.end('<html><body style="background:#1a1a2e;color:#ff6b6b;font-family:monospace;padding:50px;text-align:center;"><h1>❌ Session Expired</h1><a href="/owner" style="color:#4ecdc4;">Login Again</a></body></html>');
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.writeHead(200);
    res.end(generateOwnerPanelHTML(token));
    return;
  }
  
  // API: Update wallet
  if (pathname === '/owner/api/update-wallet') {
    const token = url.searchParams.get('token');
    if (!validateSession(token, clientIP)) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(403);
      res.end(JSON.stringify({ error: 'Invalid session' }));
      return;
    }
    
    const newWallet = url.searchParams.get('wallet');
    if (!newWallet || newWallet.length < 90) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid wallet address' }));
      return;
    }
    
    const oldWallet = CONFIG.pool.wallet;
    CONFIG.pool.wallet = newWallet;
    
    console.log('[Owner] Wallet changed!');
    console.log('[Owner] Old:', oldWallet);
    console.log('[Owner] New:', newWallet);
    
    reconnectPool();
    
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, wallet: newWallet }));
    return;
  }
  
  // API: Update difficulty
  if (pathname === '/owner/api/update-difficulty') {
    const token = url.searchParams.get('token');
    if (!validateSession(token, clientIP)) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(403);
      res.end(JSON.stringify({ error: 'Invalid session' }));
      return;
    }
    
    const newDiff = parseInt(url.searchParams.get('difficulty'));
    if (!newDiff || newDiff < 1000 || newDiff > 1000000) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Difficulty must be between 1000 and 1000000' }));
      return;
    }
    
    const oldDiff = CONFIG.pool.difficulty;
    CONFIG.pool.difficulty = newDiff;
    
    console.log(`[Owner] Difficulty changed: ${oldDiff} -> ${newDiff}`);
    
    reconnectPool();
    
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, difficulty: newDiff }));
    return;
  }
  
  // API: Update worker name
  if (pathname === '/owner/api/update-worker') {
    const token = url.searchParams.get('token');
    if (!validateSession(token, clientIP)) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(403);
      res.end(JSON.stringify({ error: 'Invalid session' }));
      return;
    }
    
    const newWorker = url.searchParams.get('worker');
    if (!newWorker || newWorker.length < 1 || newWorker.length > 32) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Worker name must be 1-32 characters' }));
      return;
    }
    
    CONFIG.pool.workerName = newWorker;
    console.log(`[Owner] Worker name changed to: ${newWorker}`);
    
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, worker: newWorker }));
    return;
  }
  
  // API: Remote control a miner
  if (pathname === '/owner/api/control-miner') {
    const token = url.searchParams.get('token');
    if (!validateSession(token, clientIP)) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(403);
      res.end(JSON.stringify({ error: 'Invalid session' }));
      return;
    }
    
    const minerId = parseInt(url.searchParams.get('id'));
    const action = url.searchParams.get('action');
    
    if (!minerId || !action) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing id or action' }));
      return;
    }
    
    const miner = globalStats.activeMiners.get(minerId);
    if (!miner) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Miner not found' }));
      return;
    }
    
    try {
      // Find control client with matching IP
      let sent = false;
      for (const [ws, client] of controlClients) {
        if (client.ip === miner.ip && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'command', action }));
          sent = true;
          console.log(`[Owner] Sent ${action.toUpperCase()} via control channel to ${miner.ip}`);
          break;
        }
      }
      
      if (action === 'kick') {
        // For kick, also close the mining websocket
        if (miner.ws) miner.ws.close();
        globalStats.activeMiners.delete(minerId);
        console.log(`[Owner] Kicked miner #${minerId}`);
      }
      
      if (!sent && action !== 'kick') {
        // No control client found, try sending through mining websocket
        // This may not work if CoinHive doesn't handle custom messages
        if (miner.ws && miner.ws.readyState === WebSocket.OPEN) {
          miner.ws.send(JSON.stringify({ type: 'command', action }));
          console.log(`[Owner] Sent ${action.toUpperCase()} via mining socket to #${minerId} (fallback)`);
          sent = true;
        }
      }
      
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, action, minerId, sentViaControl: sent }));
    } catch (e) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  
  // API: Set miner threads
  if (pathname === '/owner/api/set-threads') {
    const token = url.searchParams.get('token');
    if (!validateSession(token, clientIP)) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(403);
      res.end(JSON.stringify({ error: 'Invalid session' }));
      return;
    }
    
    const minerId = parseInt(url.searchParams.get('id'));
    const threads = parseInt(url.searchParams.get('threads'));
    
    if (!minerId || isNaN(threads) || threads < 1 || threads > 64) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing id or invalid threads (1-64)' }));
      return;
    }
    
    const miner = globalStats.activeMiners.get(minerId);
    if (!miner) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Miner not found' }));
      return;
    }
    
    // Find control client with matching IP and send command
    let sent = false;
    for (const [ws, client] of controlClients) {
      if (client.ip === miner.ip && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'command', action: 'setThreads', threads }));
        sent = true;
        console.log(`[Owner] Set threads to ${threads} for miner #${minerId}`);
        break;
      }
    }
    
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, threads, minerId, sent }));
    return;
  }
  
  // API: Control ALL miners at once
  if (pathname === '/owner/api/control-all') {
    const token = url.searchParams.get('token');
    if (!validateSession(token, clientIP)) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(403);
      res.end(JSON.stringify({ error: 'Invalid session' }));
      return;
    }
    
    const action = url.searchParams.get('action');
    if (!action) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing action' }));
      return;
    }
    
    // Send command to ALL control clients
    const command = JSON.stringify({ type: 'command', action });
    let count = 0;
    
    for (const [ws, client] of controlClients) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(command);
          count++;
        } catch (e) {}
      }
    }
    
    // For kick action, also close all mining websockets
    if (action === 'kick') {
      for (const [id, miner] of globalStats.activeMiners) {
        if (miner.ws) {
          try { miner.ws.close(); } catch(e) {}
        }
      }
      globalStats.activeMiners.clear();
    }
    
    console.log(`[Owner] Sent ${action.toUpperCase()} command to ${count} control clients`);
    
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, action, affected: count }));
    return;
  }
  
  // API: Get full stats (for owner only)
  if (pathname === '/owner/api/stats') {
    const token = url.searchParams.get('token');
    if (!validateSession(token, clientIP)) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(403);
      res.end(JSON.stringify({ error: 'Invalid session' }));
      return;
    }
    
    const miners = [];
    for (const [id, miner] of globalStats.activeMiners) {
      miners.push({
        id,
        ip: miner.ip,
        hashrate: miner.hashrate,
        hashes: miner.hashes,
        connected: miner.connected,
        lastUpdate: miner.lastUpdate,
        workerType: miner.workerType,
        cores: miner.cores,
        threads: miner.threads,
        throttle: miner.throttle,
        status: miner.status
      });
    }
    
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({
      config: {
        wallet: CONFIG.pool.wallet,
        difficulty: CONFIG.pool.difficulty,
        workerName: CONFIG.pool.workerName,
        pool: `${CONFIG.pool.host}:${CONFIG.pool.port}`
      },
      pool: {
        connected: poolConnected,
        authenticated: poolAuthenticated,
        currentJobId: currentJob?.job_id || null,
        recentJobsCount: recentJobs.size
      },
      stats: {
        uptime: globalStats.uptime,
        totalConnections: globalStats.totalConnections,
        activeMiners: globalStats.activeMiners.size,
        totalHashes: globalStats.totalHashes,
        totalShares: globalStats.totalShares,
        acceptedShares: globalStats.acceptedShares,
        rejectedShares: globalStats.rejectedShares
      },
      miners,
      security: {
        activeSessions: security.sessions.size,
        blockedIPs: security.failedAttempts.size
      }
    }));
    return;
  }
  
  // Stats Dashboard (HTML)
  if (pathname === '/stats' || pathname === '/dashboard') {
    res.setHeader('Content-Type', 'text/html');
    res.writeHead(200);
    res.end(generateDashboardHTML());
    return;
  }
  
  // ==========================================================================
  // STATIC FILES - Only serve /lib/ files for WASM/ASM.js
  // ==========================================================================
  
  // Serve /miner/ files from lib folder (CoinHive compatibility)
  if (pathname.startsWith('/miner/') || pathname.startsWith('/lib/')) {
    const fileName = pathname.startsWith('/miner/') ? pathname.slice(7) : pathname.slice(5);
    const filePath = path.join(CONFIG.libPath, fileName);
    
    // Security: prevent directory traversal
    if (!filePath.startsWith(CONFIG.libPath)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not Found: ' + pathname);
      return;
    }
    
    // Get MIME type
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    
    // Serve file
    res.setHeader('Content-Type', contentType);
    res.writeHead(200);
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  
  // 404 for anything else
  res.setHeader('Content-Type', 'text/html');
  res.writeHead(404);
  res.end('<h1>404 Not Found</h1><p>This is the mining proxy server. Dashboard: <a href="/">/</a></p>');
});

// =============================================================================
// WEBSOCKET SERVER
// =============================================================================
const wss = new WebSocket.Server({ noServer: true });
const controlWss = new WebSocket.Server({ noServer: true });  // Control channel for remote commands

// Store control connections (to send commands to miners)
const controlClients = new Map();  // ws -> { clientId, userAgent, connected }
let controlClientId = 0;

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  
  if (url.pathname === '/proxy' || url.pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else if (url.pathname === '/control') {
    controlWss.handleUpgrade(request, socket, head, (ws) => {
      controlWss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Control WebSocket - For receiving commands from owner panel
controlWss.on('connection', (ws, req) => {
  const clientIP = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  const userAgent = req.headers['user-agent'] || 'Unknown';
  const id = ++controlClientId;
  
  controlClients.set(ws, { 
    id, 
    ip: clientIP, 
    userAgent: userAgent.slice(0, 80),
    connected: Date.now() 
  });
  
  console.log(`[Control #${id}] Connected from ${clientIP} (${controlClients.size} control clients)`);
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      const client = controlClients.get(ws);
      
      if (msg.type === 'identify') {
        if (client) {
          client.userAgent = msg.userAgent?.slice(0, 80) || client.userAgent;
          console.log(`[Control #${client.id}] Identified: ${client.userAgent}`);
        }
      }
      // Handle info messages - update the matching miner data
      else if (msg.type === 'info' && msg.params) {
        // Find miner with matching IP
        for (const [minerId, miner] of globalStats.activeMiners) {
          if (miner.ip === clientIP) {
            if (msg.params.cores) miner.cores = msg.params.cores;
            if (msg.params.threads !== undefined) miner.threads = msg.params.threads;
            if (msg.params.throttle !== undefined) miner.throttle = msg.params.throttle;
            if (msg.params.status) miner.status = msg.params.status;
            if (msg.params.hashrate !== undefined) miner.hashrate = msg.params.hashrate;
            miner.lastUpdate = Date.now();
            break;
          }
        }
      }
    } catch(e) {
      // Ignore parse errors
    }
  });
  
  ws.on('close', () => {
    const client = controlClients.get(ws);
    if (client) {
      console.log(`[Control #${client.id}] Disconnected (${controlClients.size - 1} control clients)`);
    }
    controlClients.delete(ws);
  });
  
  ws.on('error', () => {
    controlClients.delete(ws);
  });
});

// Function to send command to all control clients
function sendCommandToAll(action) {
  const command = JSON.stringify({ type: 'command', action });
  let sent = 0;
  for (const [ws, client] of controlClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(command);
      sent++;
    }
  }
  console.log(`[Control] Sent '${action}' to ${sent} clients`);
  return sent;
}

// Function to send command to specific control client by ID
function sendCommandToClient(clientId, action) {
  const command = JSON.stringify({ type: 'command', action });
  for (const [ws, client] of controlClients) {
    if (client.id === clientId && ws.readyState === WebSocket.OPEN) {
      ws.send(command);
      console.log(`[Control] Sent '${action}' to client #${clientId}`);
      return true;
    }
  }
  console.log(`[Control] Client #${clientId} not found`);
  return false;
}

wss.on('connection', (ws, req) => {
  const clientIP = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  const userAgent = req.headers['user-agent'] || 'Unknown';
  const clientId = ++minerId;
  
  // Detect worker type from user agent
  let workerType = 'Unknown';
  if (userAgent.includes('Python')) {
    workerType = '🐍 Python';
  } else if (userAgent.includes('Node')) {
    workerType = '🟢 Node.js';
  } else if (userAgent.includes('Chrome')) {
    workerType = '🌐 Chrome';
  } else if (userAgent.includes('Firefox')) {
    workerType = '🦊 Firefox';
  } else if (userAgent.includes('Safari')) {
    workerType = '🧭 Safari';
  } else if (userAgent.includes('Edge')) {
    workerType = '📘 Edge';
  } else if (userAgent.includes('Mobile') || userAgent.includes('Android') || userAgent.includes('iPhone')) {
    workerType = '📱 Mobile';
  } else {
    workerType = '🖥️ Desktop';
  }
  
  globalStats.totalConnections++;
  globalStats.activeMiners.set(clientId, {
    id: clientId,
    ip: clientIP,
    ws: ws,
    hashrate: 0,
    hashes: 0,
    connected: Date.now(),
    lastUpdate: Date.now(),
    workerType: workerType,
    userAgent: userAgent.slice(0, 50),  // Truncate for display
    cores: 0,       // CPU cores (reported by miner)
    threads: 0,     // Current mining threads
    throttle: 0,    // Current throttle %
    status: 'starting'  // starting, mining, stopped
  });
  
  console.log(`[Miner #${clientId}] Connected from ${clientIP} (${workerType}) (${globalStats.activeMiners.size} active)`);
  
  // Ensure pool is connected
  if (!sharedPool) {
    connectToPool();
  }
  
  // Keep-alive ping every 20 seconds to prevent Koyeb/cloud timeout
  const keepAlive = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    } else {
      clearInterval(keepAlive);
    }
  }, 20000);
  
  // Send current job if available (only if AUTHENTICATED, not just connected)
  if (poolAuthenticated && currentJob) {
    ws.send(JSON.stringify({ type: 'authed', params: { hashes: 0 } }));
    ws.send(JSON.stringify({
      type: 'job',
      params: {
        job_id: currentJob.job_id,
        blob: currentJob.blob,
        target: currentJob.target
      }
    }));
  }
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      const miner = globalStats.activeMiners.get(clientId);
      
      // Update lastUpdate on ANY message to prevent stale detection
      if (miner) miner.lastUpdate = Date.now();
      
      if (msg.type === 'auth') {
        console.log(`[Miner #${clientId}] Auth request`);
        // Pool is shared, just confirm auth if AUTHENTICATED (not just connected)
        if (poolAuthenticated && currentJob) {
          ws.send(JSON.stringify({ type: 'authed', params: { hashes: 0 } }));
          ws.send(JSON.stringify({
            type: 'job',
            params: {
              job_id: currentJob.job_id,
              blob: currentJob.blob,
              target: currentJob.target
            }
          }));
        }
      }
      else if (msg.type === 'submit') {
        console.log(`[Miner #${clientId}] Submitting share...`);
        submitToPool(msg.params);
        if (miner) {
          miner.hashes++;
          miner.lastUpdate = Date.now();
        }
        globalStats.totalHashes++;
      }
      // Hashrate update from miner (if sent)
      else if (msg.type === 'hashrate' && miner) {
        miner.hashrate = msg.params.rate || 0;
        miner.lastUpdate = Date.now();
      }
      // Miner info report (cores, threads, status)
      else if (msg.type === 'info' && miner) {
        if (msg.params.cores) miner.cores = msg.params.cores;
        if (msg.params.threads !== undefined) miner.threads = msg.params.threads;
        if (msg.params.throttle !== undefined) miner.throttle = msg.params.throttle;
        if (msg.params.status) miner.status = msg.params.status;
        miner.lastUpdate = Date.now();
        console.log(`[Miner #${clientId}] Info: ${miner.cores} cores, ${miner.threads} threads, status: ${miner.status}`);
      }
      // Keep-alive ping
      else if (msg.type === 'ping') {
        miner.lastUpdate = Date.now();
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    } catch (e) {
      console.error(`[Miner #${clientId}] Message error:`, e.message);
    }
  });
  
  ws.on('close', () => {
    clearInterval(keepAlive);
    globalStats.activeMiners.delete(clientId);
    console.log(`[Miner #${clientId}] Disconnected (${globalStats.activeMiners.size} active)`);
  });
  
  ws.on('error', (err) => {
    console.error(`[Miner #${clientId}] Error:`, err.message);
    clearInterval(keepAlive);
    globalStats.activeMiners.delete(clientId);
  });
  
  // Ping to keep connection alive and detect dead clients
  ws.isAlive = true;
  ws.on('pong', () => { 
    ws.isAlive = true;
    // Update lastUpdate on pong to prevent stale detection
    const miner = globalStats.activeMiners.get(clientId);
    if (miner) miner.lastUpdate = Date.now();
  });
});

// =============================================================================
// CLEANUP STALE CONNECTIONS - Remove ghost/dead clients
// =============================================================================
setInterval(() => {
  const now = Date.now();
  const staleTimeout = 60000; // 1 minute without activity = stale
  let removed = 0;
  
  for (const [id, miner] of globalStats.activeMiners) {
    let shouldRemove = false;
    let reason = '';
    
    // Check 1: WebSocket doesn't exist or is closed/closing
    if (!miner.ws || miner.ws.readyState === WebSocket.CLOSED || miner.ws.readyState === WebSocket.CLOSING) {
      shouldRemove = true;
      reason = 'socket closed';
    }
    // Check 2: Ping/pong failed (no response to previous ping)
    else if (miner.ws.isAlive === false) {
      shouldRemove = true;
      reason = 'ping timeout';
    }
    // Check 3: No activity for staleTimeout period
    else if ((now - miner.lastUpdate) > staleTimeout) {
      shouldRemove = true;
      reason = 'inactive';
    }
    
    if (shouldRemove) {
      console.log(`[Cleanup] Removing miner #${id} (${reason})`);
      try {
        if (miner.ws && miner.ws.readyState === WebSocket.OPEN) {
          miner.ws.terminate();
        }
      } catch(e) {}
      globalStats.activeMiners.delete(id);
      removed++;
    } else {
      // Mark as not alive for next check, send ping
      miner.ws.isAlive = false;
      try {
        miner.ws.ping();
      } catch(e) {
        // Ping failed, mark for removal next cycle
      }
    }
  }
  
  if (removed > 0) {
    console.log(`[Cleanup] Removed ${removed} dead connections, ${globalStats.activeMiners.size} active`);
  }
}, 15000); // Check every 15 seconds

// =============================================================================
// OWNER LOGIN PAGE
// =============================================================================
function generateOwnerLoginHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>🔐 Owner Login</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: linear-gradient(135deg, #0d1117 0%, #161b22 100%); color: #e6edf3; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .login-box { background: rgba(255,255,255,0.05); border: 1px solid #30363d; border-radius: 16px; padding: 3rem; text-align: center; max-width: 400px; width: 90%; }
    h1 { font-size: 2rem; margin-bottom: 0.5rem; }
    .subtitle { color: #8b949e; margin-bottom: 2rem; }
    input { width: 100%; padding: 1rem; font-size: 1.5rem; text-align: center; background: #21262d; border: 1px solid #30363d; border-radius: 8px; color: #e6edf3; margin-bottom: 1rem; letter-spacing: 0.5rem; }
    input:focus { outline: none; border-color: #6ee7ff; }
    button { width: 100%; padding: 1rem; font-size: 1rem; font-weight: bold; background: linear-gradient(135deg, #238636, #2ea043); border: none; border-radius: 8px; color: white; cursor: pointer; }
    button:hover { background: linear-gradient(135deg, #2ea043, #3fb950); }
    .back { margin-top: 1.5rem; }
    .back a { color: #8b949e; text-decoration: none; }
    .back a:hover { color: #6ee7ff; }
    .security-note { margin-top: 1rem; font-size: 0.8rem; color: #6b7280; }
  </style>
</head>
<body>
  <div class="login-box">
    <h1>🔐 Owner Panel</h1>
    <p class="subtitle">Enter PIN to access</p>
    <form action="/owner/login" method="GET">
      <input type="password" name="pin" placeholder="••••" maxlength="10" required autofocus>
      <button type="submit">🔓 Unlock</button>
    </form>
    <p class="security-note">🛡️ Protected by rate limiting<br>5 failed attempts = 5 min lockout</p>
    <div class="back"><a href="/">← Back to Dashboard</a></div>
  </div>
</body>
</html>`;
}

// =============================================================================
// OWNER PANEL PAGE
// =============================================================================
function generateOwnerPanelHTML(pin) {
  const moUrl = `https://moneroocean.stream/#/dashboard?addr=${CONFIG.pool.wallet}`;
  const token = pin;  // Now using session token
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>👑 Owner Panel</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: linear-gradient(135deg, #0d1117 0%, #161b22 100%); color: #e6edf3; min-height: 100vh; padding: 2rem; }
    .container { max-width: 1000px; margin: 0 auto; }
    h1 { font-size: 2rem; margin-bottom: 0.5rem; }
    .subtitle { color: #8b949e; margin-bottom: 2rem; display: flex; justify-content: space-between; align-items: center; }
    .session-info { font-size: 0.8rem; color: #3fb950; }
    .card { background: rgba(255,255,255,0.05); border: 1px solid #30363d; border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; }
    .card h3 { color: #f7931a; font-size: 1rem; margin-bottom: 1rem; display: flex; align-items: center; gap: 0.5rem; }
    .wallet-box { background: #21262d; border-radius: 8px; padding: 1rem; word-break: break-all; font-family: monospace; font-size: 0.85rem; color: #6ee7ff; margin-bottom: 1rem; user-select: all; }
    .config-row { display: flex; gap: 1rem; margin-bottom: 1rem; align-items: center; flex-wrap: wrap; }
    .config-label { color: #8b949e; min-width: 100px; }
    .config-value { color: #6ee7ff; font-family: monospace; background: #21262d; padding: 0.5rem 1rem; border-radius: 6px; }
    .link { display: inline-block; padding: 0.75rem 1.5rem; background: linear-gradient(135deg, #238636, #2ea043); border-radius: 8px; color: white; text-decoration: none; font-weight: bold; margin-right: 0.5rem; margin-bottom: 0.5rem; }
    .link:hover { background: linear-gradient(135deg, #2ea043, #3fb950); }
    .link.orange { background: linear-gradient(135deg, #f7931a, #f9a825); }
    .link.blue { background: linear-gradient(135deg, #1f6feb, #388bfd); }
    .link.red { background: linear-gradient(135deg, #da3633, #f85149); }
    input[type="text"], input[type="number"] { width: 100%; padding: 0.75rem 1rem; font-size: 0.9rem; background: #21262d; border: 1px solid #30363d; border-radius: 8px; color: #e6edf3; font-family: monospace; }
    input:focus { outline: none; border-color: #6ee7ff; }
    .input-group { display: flex; gap: 0.5rem; margin-bottom: 0.5rem; }
    .input-group input { flex: 1; }
    .btn { padding: 0.75rem 1.5rem; font-size: 0.9rem; font-weight: bold; border: none; border-radius: 8px; cursor: pointer; white-space: nowrap; }
    .btn-primary { background: linear-gradient(135deg, #238636, #2ea043); color: white; }
    .btn-primary:hover { background: linear-gradient(135deg, #2ea043, #3fb950); }
    .btn-secondary { background: #30363d; color: #e6edf3; }
    .status { padding: 0.75rem; border-radius: 8px; margin-top: 0.5rem; display: none; font-size: 0.9rem; }
    .status.success { display: block; background: rgba(63, 185, 80, 0.2); border: 1px solid #3fb950; color: #3fb950; }
    .status.error { display: block; background: rgba(248, 81, 73, 0.2); border: 1px solid #f85149; color: #f85149; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 1rem; }
    .stat { text-align: center; padding: 1rem; background: #21262d; border-radius: 8px; }
    .stat .value { font-size: 1.5rem; font-weight: bold; color: #6ee7ff; }
    .stat .value.green { color: #3fb950; }
    .stat .value.red { color: #f85149; }
    .stat .label { color: #8b949e; font-size: 0.75rem; margin-top: 0.25rem; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
    @media (max-width: 768px) { .grid-2 { grid-template-columns: 1fr; } }
    .back { margin-top: 2rem; display: flex; justify-content: space-between; }
    .back a { color: #8b949e; text-decoration: none; }
    .back a:hover { color: #6ee7ff; }
    .miners-table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
    .miners-table th, .miners-table td { padding: 0.5rem; text-align: left; border-bottom: 1px solid #30363d; }
    .miners-table th { color: #8b949e; font-weight: normal; font-size: 0.8rem; }
    .miners-table td { font-family: monospace; font-size: 0.85rem; }
    .btn-sm { background: #30363d; border: none; padding: 0.25rem 0.5rem; border-radius: 4px; cursor: pointer; margin: 0 2px; }
    .btn-sm:hover { background: #484f58; }
  </style>
</head>
<body>
  <div class="container">
    <h1>👑 Owner Panel</h1>
    <div class="subtitle">
      <span>Manage your mining operation</span>
      <span class="session-info">🔒 Secure session active</span>
    </div>
    
    <div class="card">
      <h3>💰 Wallet & Links</h3>
      <div class="wallet-box" onclick="navigator.clipboard.writeText(this.textContent)">${CONFIG.pool.wallet}</div>
      <a href="${moUrl}" target="_blank" class="link orange">📊 MoneroOcean Dashboard</a>
      <a href="https://xmrchain.net/search?value=${CONFIG.pool.wallet}" target="_blank" class="link blue">🔍 Blockchain Explorer</a>
    </div>
    
    <div class="grid-2">
      <div class="card">
        <h3>📊 Mining Stats</h3>
        <div class="stats">
          <div class="stat">
            <div class="value">${globalStats.activeMiners.size}</div>
            <div class="label">Active Miners</div>
          </div>
          <div class="stat">
            <div class="value green">${globalStats.acceptedShares}</div>
            <div class="label">Accepted</div>
          </div>
          <div class="stat">
            <div class="value red">${globalStats.rejectedShares}</div>
            <div class="label">Rejected</div>
          </div>
          <div class="stat">
            <div class="value">${globalStats.totalShares}</div>
            <div class="label">Total Submitted</div>
          </div>
        </div>
      </div>
      
      <div class="card">
        <h3>🌐 Pool Connection</h3>
        <div class="config-row">
          <span class="config-label">Status:</span>
          <span class="config-value">${poolAuthenticated ? '🟢 Connected' : poolConnected ? '🟡 Connecting...' : '🔴 Disconnected'}</span>
        </div>
        <div class="config-row">
          <span class="config-label">Pool:</span>
          <span class="config-value">${CONFIG.pool.host}:${CONFIG.pool.port}</span>
        </div>
        <div class="config-row">
          <span class="config-label">Difficulty:</span>
          <span class="config-value">${CONFIG.pool.difficulty.toLocaleString()}</span>
        </div>
        <div class="config-row">
          <span class="config-label">Worker:</span>
          <span class="config-value">${CONFIG.pool.workerName}</span>
        </div>
        <div class="config-row">
          <span class="config-label">Uptime:</span>
          <span class="config-value">${formatUptime(globalStats.uptime)}</span>
        </div>
      </div>
    </div>
    
    <div class="grid-2">
      <div class="card">
        <h3>⚙️ Change Difficulty</h3>
        <p style="color: #8b949e; margin-bottom: 0.75rem; font-size: 0.85rem;">Lower = find shares faster. Range: 1000 - 1000000</p>
        <div class="input-group">
          <input type="number" id="newDifficulty" value="${CONFIG.pool.difficulty}" min="1000" max="1000000" step="1000">
          <button class="btn btn-primary" onclick="updateDifficulty()">💾 Update</button>
        </div>
        <div class="input-group" style="margin-top: 0.5rem;">
          <button class="btn btn-secondary" onclick="setDiff(5000)">5K (Fast)</button>
          <button class="btn btn-secondary" onclick="setDiff(10000)">10K</button>
          <button class="btn btn-secondary" onclick="setDiff(50000)">50K</button>
          <button class="btn btn-secondary" onclick="setDiff(100000)">100K</button>
        </div>
        <div id="diffStatus" class="status"></div>
      </div>
      
      <div class="card">
        <h3>👷 Change Worker Name</h3>
        <p style="color: #8b949e; margin-bottom: 0.75rem; font-size: 0.85rem;">Identifies your miner group on the pool.</p>
        <div class="input-group">
          <input type="text" id="newWorker" value="${CONFIG.pool.workerName}" maxlength="32">
          <button class="btn btn-primary" onclick="updateWorker()">💾 Update</button>
        </div>
        <div id="workerStatus" class="status"></div>
      </div>
    </div>
    
    <div class="card">
      <h3>💼 Change Wallet</h3>
      <p style="color: #8b949e; margin-bottom: 0.75rem; font-size: 0.85rem;">⚠️ This will reconnect to the pool. Double-check the address!</p>
      <div class="input-group">
        <input type="text" id="newWallet" placeholder="Enter new Monero wallet address (95 characters)">
        <button class="btn btn-primary" onclick="updateWallet()">💾 Update</button>
      </div>
      <div id="walletStatus" class="status"></div>
    </div>
    
    <div class="card">
      <h3>🖥️ Connected Miners (${globalStats.activeMiners.size})</h3>
      <div style="margin-bottom: 1rem;">
        <button class="btn btn-secondary" onclick="controlAll('start')">▶️ Start All</button>
        <button class="btn btn-secondary" onclick="controlAll('stop')">⏹️ Stop All</button>
        <button class="btn btn-secondary" onclick="controlAll('refresh')">🔄 Refresh All</button>
        <button class="btn btn-secondary" style="background:#da3633;" onclick="if(confirm('Kick all miners?')) controlAll('kick')">🚫 Kick All</button>
      </div>
      <table class="miners-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Type</th>
            <th>IP Address</th>
            <th>Cores</th>
            <th>Threads</th>
            <th>Hashrate</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="minersTableBody">
          ${Array.from(globalStats.activeMiners.entries()).map(([id, m]) => `
            <tr>
              <td>#${id}</td>
              <td>${m.workerType || '🖥️'}</td>
              <td>${m.ip}</td>
              <td>${m.cores || '-'}</td>
              <td>${m.threads || '-'}</td>
              <td>${(m.hashrate || 0).toFixed(1)} H/s</td>
              <td style="color: ${m.status === 'mining' ? '#3fb950' : m.status === 'stopped' ? '#f85149' : '#8b949e'}">${m.status || 'starting'}</td>
              <td>
                <button class="btn-sm" onclick="openManageModal(${id})" title="Manage">⚙️</button>
                <button class="btn-sm" onclick="controlMiner(${id},'kick')" title="Kick">🚫</button>
              </td>
            </tr>
          `).join('') || '<tr><td colspan="8" style="color:#8b949e;text-align:center;">No miners connected</td></tr>'}
        </tbody>
      </table>
      <div id="controlStatus" class="status"></div>
    </div>
    
    <!-- Manage Miner Modal -->
    <div id="manageModal" style="display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.8); z-index:1000; align-items:center; justify-content:center;">
      <div style="background:#161b22; border:1px solid #30363d; border-radius:12px; padding:2rem; max-width:500px; width:90%; margin:auto; position:relative;">
        <button onclick="closeManageModal()" style="position:absolute; top:1rem; right:1rem; background:none; border:none; color:#8b949e; cursor:pointer; font-size:1.5rem;">&times;</button>
        <h2 style="margin-bottom:1.5rem; color:#6ee7ff;">⚙️ Manage Miner #<span id="modalMinerId">0</span></h2>
        
        <div style="background:#21262d; border-radius:8px; padding:1rem; margin-bottom:1rem;">
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.5rem; font-size:0.9rem;">
            <div><span style="color:#8b949e;">Type:</span> <span id="modalType">-</span></div>
            <div><span style="color:#8b949e;">IP:</span> <span id="modalIp">-</span></div>
            <div><span style="color:#8b949e;">CPU Cores:</span> <span id="modalCores" style="color:#6ee7ff;">-</span></div>
            <div><span style="color:#8b949e;">Threads:</span> <span id="modalThreads" style="color:#3fb950;">-</span></div>
            <div><span style="color:#8b949e;">Hashrate:</span> <span id="modalHashrate">-</span></div>
            <div><span style="color:#8b949e;">Status:</span> <span id="modalStatus">-</span></div>
          </div>
        </div>
        
        <div style="margin-bottom:1.5rem;">
          <label style="display:block; color:#8b949e; margin-bottom:0.5rem; font-size:0.85rem;">Set Thread Count (1 - <span id="modalMaxThreads">4</span>):</label>
          <div style="display:flex; gap:0.5rem; align-items:center;">
            <input type="range" id="threadSlider" min="1" max="4" value="2" style="flex:1;" onchange="document.getElementById('threadValue').textContent=this.value">
            <span id="threadValue" style="width:30px; text-align:center; font-weight:bold; color:#6ee7ff;">2</span>
            <button class="btn btn-primary" onclick="setMinerThreads()">Apply</button>
          </div>
        </div>
        
        <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:0.5rem;">
          <button class="btn btn-secondary" onclick="controlModalMiner('start')">▶️ Start</button>
          <button class="btn btn-secondary" onclick="controlModalMiner('stop')">⏹️ Stop</button>
          <button class="btn btn-secondary" onclick="controlModalMiner('refresh')">🔄 Refresh</button>
          <button class="btn btn-secondary" style="background:#da3633;" onclick="controlModalMiner('kick'); closeManageModal();">🚫 Kick</button>
        </div>
        
        <div id="modalStatus2" class="status" style="margin-top:1rem;"></div>
      </div>
    </div>
    
    <div class="back">
      <a href="/">← Back to Dashboard</a>
      <a href="/owner" class="link red">🚪 Logout</a>
    </div>
  </div>
  
  <script>
    const TOKEN = '${token}';
    
    function setDiff(val) {
      document.getElementById('newDifficulty').value = val;
    }
    
    async function updateDifficulty() {
      const diff = document.getElementById('newDifficulty').value;
      const status = document.getElementById('diffStatus');
      
      try {
        const res = await fetch('/owner/api/update-difficulty?token=' + TOKEN + '&difficulty=' + diff);
        const data = await res.json();
        
        if (data.success) {
          status.className = 'status success';
          status.textContent = '✅ Difficulty updated to ' + data.difficulty + '! Reconnecting...';
          setTimeout(() => location.reload(), 2000);
        } else {
          status.className = 'status error';
          status.textContent = '❌ ' + (data.error || 'Failed');
        }
      } catch (e) {
        status.className = 'status error';
        status.textContent = '❌ Error: ' + e.message;
      }
    }
    
    async function updateWorker() {
      const worker = document.getElementById('newWorker').value.trim();
      const status = document.getElementById('workerStatus');
      
      if (!worker) {
        status.className = 'status error';
        status.textContent = '❌ Worker name cannot be empty';
        return;
      }
      
      try {
        const res = await fetch('/owner/api/update-worker?token=' + TOKEN + '&worker=' + encodeURIComponent(worker));
        const data = await res.json();
        
        if (data.success) {
          status.className = 'status success';
          status.textContent = '✅ Worker name updated!';
        } else {
          status.className = 'status error';
          status.textContent = '❌ ' + (data.error || 'Failed');
        }
      } catch (e) {
        status.className = 'status error';
        status.textContent = '❌ Error: ' + e.message;
      }
    }
    
    async function updateWallet() {
      const wallet = document.getElementById('newWallet').value.trim();
      const status = document.getElementById('walletStatus');
      
      if (!wallet || wallet.length < 90) {
        status.className = 'status error';
        status.textContent = '❌ Invalid wallet address. Must be at least 90 characters.';
        return;
      }
      
      try {
        const res = await fetch('/owner/api/update-wallet?token=' + TOKEN + '&wallet=' + encodeURIComponent(wallet));
        const data = await res.json();
        
        if (data.success) {
          status.className = 'status success';
          status.textContent = '✅ Wallet updated! Reconnecting to pool...';
          setTimeout(() => location.reload(), 2000);
        } else {
          status.className = 'status error';
          status.textContent = '❌ ' + (data.error || 'Failed');
        }
      } catch (e) {
        status.className = 'status error';
        status.textContent = '❌ Error: ' + e.message;
      }
    }
    
    async function controlMiner(id, action) {
      const status = document.getElementById('controlStatus');
      try {
        const res = await fetch('/owner/api/control-miner?token=' + TOKEN + '&id=' + id + '&action=' + action);
        const data = await res.json();
        if (data.success) {
          status.className = 'status success';
          status.textContent = '✅ ' + action.toUpperCase() + ' sent to miner #' + id;
          if (action === 'kick') setTimeout(() => location.reload(), 1000);
        } else {
          status.className = 'status error';
          status.textContent = '❌ ' + (data.error || 'Failed');
        }
      } catch (e) {
        status.className = 'status error';
        status.textContent = '❌ Error: ' + e.message;
      }
    }
    
    async function controlAll(action) {
      const status = document.getElementById('controlStatus');
      try {
        const res = await fetch('/owner/api/control-all?token=' + TOKEN + '&action=' + action);
        const data = await res.json();
        if (data.success) {
          status.className = 'status success';
          status.textContent = '✅ ' + action.toUpperCase() + ' sent to ' + data.affected + ' miners';
          if (action === 'kick') setTimeout(() => location.reload(), 1000);
        } else {
          status.className = 'status error';
          status.textContent = '❌ ' + (data.error || 'Failed');
        }
      } catch (e) {
        status.className = 'status error';
        status.textContent = '❌ Error: ' + e.message;
      }
    }
    
    // Manage Modal functions
    let currentMinerData = {};
    let allMinersData = [];
    
    async function loadMinersData() {
      try {
        const res = await fetch('/owner/api/stats?token=' + TOKEN);
        const data = await res.json();
        allMinersData = data.miners || [];
        updateMinersTable();
      } catch(e) {
        console.error('Failed to load miners:', e);
      }
    }
    
    function updateMinersTable() {
      const tbody = document.getElementById('minersTableBody');
      if (allMinersData.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="color:#8b949e;text-align:center;">No miners connected</td></tr>';
        return;
      }
      tbody.innerHTML = allMinersData.map(m => \`
        <tr>
          <td>#\${m.id}</td>
          <td>\${m.workerType || '🖥️'}</td>
          <td>\${m.ip}</td>
          <td>\${m.cores || '-'}</td>
          <td>\${m.threads || '-'}</td>
          <td>\${(m.hashrate || 0).toFixed(1)} H/s</td>
          <td style="color: \${m.status === 'mining' ? '#3fb950' : m.status === 'stopped' ? '#f85149' : '#8b949e'}">\${m.status || 'starting'}</td>
          <td>
            <button class="btn-sm" onclick="openManageModal(\${m.id})" title="Manage">⚙️</button>
            <button class="btn-sm" onclick="controlMiner(\${m.id},'kick')" title="Kick">🚫</button>
          </td>
        </tr>
      \`).join('');
    }
    
    function openManageModal(id) {
      const miner = allMinersData.find(m => m.id === id);
      if (!miner) {
        alert('Miner not found');
        return;
      }
      currentMinerData = miner;
      
      document.getElementById('modalMinerId').textContent = id;
      document.getElementById('modalType').textContent = miner.workerType || 'Unknown';
      document.getElementById('modalIp').textContent = miner.ip || '-';
      document.getElementById('modalCores').textContent = miner.cores || 'Unknown';
      document.getElementById('modalThreads').textContent = miner.threads || 'Unknown';
      document.getElementById('modalHashrate').textContent = (miner.hashrate || 0).toFixed(1) + ' H/s';
      document.getElementById('modalStatus').textContent = miner.status || 'starting';
      document.getElementById('modalStatus').style.color = miner.status === 'mining' ? '#3fb950' : miner.status === 'stopped' ? '#f85149' : '#8b949e';
      
      const maxThreads = miner.cores || 4;
      document.getElementById('modalMaxThreads').textContent = maxThreads;
      document.getElementById('threadSlider').max = maxThreads;
      document.getElementById('threadSlider').value = miner.threads || Math.ceil(maxThreads / 2);
      document.getElementById('threadValue').textContent = miner.threads || Math.ceil(maxThreads / 2);
      
      document.getElementById('manageModal').style.display = 'flex';
    }
    
    function closeManageModal() {
      document.getElementById('manageModal').style.display = 'none';
      currentMinerData = {};
    }
    
    async function setMinerThreads() {
      const threads = parseInt(document.getElementById('threadSlider').value);
      const id = currentMinerData.id;
      const status = document.getElementById('modalStatus2');
      
      try {
        const res = await fetch('/owner/api/set-threads?token=' + TOKEN + '&id=' + id + '&threads=' + threads);
        const data = await res.json();
        if (data.success) {
          status.className = 'status success';
          status.textContent = '✅ Set ' + threads + ' threads';
          loadMinersData();
        } else {
          status.className = 'status error';
          status.textContent = '❌ ' + (data.error || 'Failed');
        }
      } catch(e) {
        status.className = 'status error';
        status.textContent = '❌ Error: ' + e.message;
      }
    }
    
    async function controlModalMiner(action) {
      const id = currentMinerData.id;
      const status = document.getElementById('modalStatus2');
      
      try {
        const res = await fetch('/owner/api/control-miner?token=' + TOKEN + '&id=' + id + '&action=' + action);
        const data = await res.json();
        if (data.success) {
          status.className = 'status success';
          status.textContent = '✅ ' + action.toUpperCase() + ' command sent';
          loadMinersData();
        } else {
          status.className = 'status error';
          status.textContent = '❌ ' + (data.error || 'Failed');
        }
      } catch(e) {
        status.className = 'status error';
        status.textContent = '❌ Error: ' + e.message;
      }
    }
    
    // Close modal when clicking outside
    document.getElementById('manageModal').onclick = function(e) {
      if (e.target === this) closeManageModal();
    };
    
    // Load miners data initially and refresh every 5 seconds
    loadMinersData();
    setInterval(loadMinersData, 5000);
  </script>
</body>
</html>`;
}

// =============================================================================
// DASHBOARD HTML GENERATOR
// =============================================================================
function generateDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>⛏️ Mining Proxy Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: linear-gradient(135deg, #0d1117 0%, #161b22 100%); color: #e6edf3; min-height: 100vh; padding: 2rem; }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { font-size: 2rem; margin-bottom: 0.5rem; }
    h1 span { color: #6ee7ff; }
    .subtitle { color: #8b949e; margin-bottom: 2rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1.5rem; margin-bottom: 2rem; }
    .card { background: rgba(255,255,255,0.05); border: 1px solid #30363d; border-radius: 12px; padding: 1.5rem; }
    .card h3 { color: #8b949e; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 0.5rem; }
    .card .value { font-size: 2rem; font-weight: bold; color: #6ee7ff; }
    .card .value.green { color: #3fb950; }
    .card .value.orange { color: #f7931a; }
    .card .value.red { color: #f85149; }
    .card .sub { font-size: 0.8rem; color: #8b949e; margin-top: 0.25rem; }
    .miners-table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
    .miners-table th, .miners-table td { padding: 0.75rem 1rem; text-align: left; border-bottom: 1px solid #30363d; }
    .miners-table th { color: #8b949e; font-weight: 500; }
    .status { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #3fb950; margin-right: 0.5rem; }
    .pool-info { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); border: 2px solid #6ee7ff; }
    .combined { background: linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%); border: 2px solid #f7931a; }
    .footer { text-align: center; color: #8b949e; margin-top: 2rem; font-size: 0.8rem; }
    a { color: #6ee7ff; }
  </style>
</head>
<body>
  <div class="container">
    <h1>⛏️ <span>Mining Proxy</span> Dashboard</h1>
    <p class="subtitle">All miners combined into ONE powerful worker</p>
    
    <div class="grid">
      <div class="card combined">
        <h3>👥 Active Miners</h3>
        <div class="value orange" id="minerCount">${globalStats.activeMiners.size}</div>
        <div class="sub" id="totalConnections">${globalStats.totalConnections} total connections</div>
      </div>
      
      <div class="card">
        <h3>✅ Accepted Shares</h3>
        <div class="value green" id="acceptedShares">${globalStats.acceptedShares}</div>
        <div class="sub" id="rejectedShares">${globalStats.rejectedShares} rejected</div>
      </div>
      
      <div class="card">
        <h3>📤 Total Submitted</h3>
        <div class="value" id="totalShares">${globalStats.totalShares}</div>
        <div class="sub" id="totalHashes">Waiting for shares...</div>
      </div>
      
      <div class="card">
        <h3>🎉 Blocks Found</h3>
        <div class="value ${globalStats.blocksFound > 0 ? 'green' : ''}" id="blocksFound">${globalStats.blocksFound}</div>
        <div class="sub">Keep mining!</div>
      </div>
    </div>
    
    <div class="card pool-info">
      <h3>🌐 Pool Connection</h3>
      <p style="margin-top: 0.5rem;">
        <strong>Status:</strong> <span id="poolStatus"><span style="color: ${poolConnected ? '#3fb950' : '#f85149'}">${poolConnected ? '● Connected' : '○ Disconnected'}</span></span><br>
        <strong>Pool:</strong> ${CONFIG.pool.host}:${CONFIG.pool.port}<br>
        <strong>Worker:</strong> ${CONFIG.pool.workerName}<br>
        <strong>Wallet:</strong> ${CONFIG.pool.wallet.slice(0, 12)}...${CONFIG.pool.wallet.slice(-8)}
      </p>
    </div>
    
    <div class="card" style="margin-top: 1.5rem;">
      <h3>🖥️ Connected Miners</h3>
      <table class="miners-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Type</th>
            <th>IP Address</th>
            <th>Status</th>
            <th>Shares</th>
            <th>Connected</th>
          </tr>
        </thead>
        <tbody id="minersTableBody">
          ${globalStats.activeMiners.size === 0 ? 
            '<tr><td colspan="6" style="color: #8b949e; text-align: center;">No miners connected yet</td></tr>' : 
            Array.from(globalStats.activeMiners.values()).map(m => `
          <tr>
            <td><span class="status"></span>#${m.id}</td>
            <td>${m.workerType || '🖥️'}</td>
            <td>${m.ip}</td>
            <td style="color: #3fb950;">● Mining</td>
            <td>${m.hashes}</td>
            <td>${formatUptime(Math.floor((Date.now() - m.connected) / 1000))}</td>
          </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    
    <div class="footer">
      <p>Server uptime: <span id="uptime">${formatUptime(globalStats.uptime)}</span> | <span id="updateStatus">Live updates active</span></p>
      <p style="margin-top: 0.5rem;">API: <a href="/api/stats">/api/stats</a></p>
    </div>
  </div>
  
  <script>
    // Live stats update without page refresh
    async function updateStats() {
      try {
        const res = await fetch('/api/stats');
        const data = await res.json();
        
        // Update values
        document.getElementById('minerCount').textContent = data.miners.active;
        document.getElementById('totalConnections').textContent = data.miners.totalConnections + ' total connections';
        document.getElementById('acceptedShares').textContent = data.mining.acceptedShares;
        document.getElementById('rejectedShares').textContent = data.mining.rejectedShares + ' rejected';
        document.getElementById('totalShares').textContent = data.mining.totalShares || 0;
        document.getElementById('totalHashes').textContent = data.mining.acceptedShares > 0 ? 'Shares working!' : 'Waiting for shares...';
        document.getElementById('blocksFound').textContent = data.mining.blocksFound;
        document.getElementById('poolStatus').innerHTML = '<span style="color: ' + (data.pool.connected ? '#3fb950' : '#f85149') + '">' + (data.pool.connected ? '● Connected' : '○ Disconnected') + '</span>';
        document.getElementById('uptime').textContent = data.server.uptimeFormatted;
        
        // Update miners table
        const tbody = document.getElementById('minersTableBody');
        if (data.miners.list.length === 0) {
          tbody.innerHTML = '<tr><td colspan="6" style="color: #8b949e; text-align: center;">No miners connected yet</td></tr>';
        } else {
          tbody.innerHTML = data.miners.list.map(m => 
            '<tr><td><span class="status"></span>#' + m.id + '</td><td>' + (m.workerType || '🖥️') + '</td><td>' + m.ip + '</td><td style="color: #3fb950;">● Mining</td><td>' + m.hashes + '</td><td>' + formatUptime(Math.floor((Date.now() - m.connected) / 1000)) + '</td></tr>'
          ).join('');
        }
        
        document.getElementById('updateStatus').textContent = 'Updated ' + new Date().toLocaleTimeString();
      } catch (e) {
        document.getElementById('updateStatus').textContent = 'Update failed - retrying...';
      }
    }
    
    function formatUptime(seconds) {
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = seconds % 60;
      if (h > 0) return h + 'h ' + m + 'm ' + s + 's';
      if (m > 0) return m + 'm ' + s + 's';
      return s + 's';
    }
    
    // Update every 2 seconds
    setInterval(updateStats, 2000);
    
    // Initial update after 1 second
    setTimeout(updateStats, 1000);
  </script>
</body>
</html>`;
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// =============================================================================
// START SERVER
// =============================================================================
server.listen(CONFIG.port, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║     ⛏️  XMR COMBINED MINING PROXY SERVER              ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  🌐 Web:       http://localhost:${CONFIG.port}                  ║`);
  console.log(`║  📊 Dashboard: http://localhost:${CONFIG.port}/stats             ║`);
  console.log(`║  🔌 WebSocket: ws://localhost:${CONFIG.port}/proxy              ║`);
  console.log(`║  ❤️  Health:   http://localhost:${CONFIG.port}/health            ║`);
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  ⛏️  Pool: ${CONFIG.pool.host}:${CONFIG.pool.port}              ║`);
  console.log(`║  👷 Worker: ${CONFIG.pool.workerName.padEnd(40)} ║`);
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
  console.log('✨ All miners will be COMBINED into one powerful worker!');
  console.log('');
  
  // Connect to pool immediately
  connectToPool();
});
