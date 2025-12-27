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
  
  // Pool settings
  pool: {
    host: process.env.POOL_HOST || 'gulf.moneroocean.stream',
    port: parseInt(process.env.POOL_PORT) || 10128,
    wallet: process.env.WALLET || '43fx9ijTgKESpbsYjukgHiNDLqoZXnkuZVyBnRkNmbCFDz43us6qtdNM1nSSYJ1AUdUSXbTBn2k8rVWBWB4zRfDaGaiBYUQ',
    workerName: process.env.WORKER_NAME || 'CombinedWebMiners',
    // Fixed difficulty 10000 = shares found faster, less stale shares
    // Format: "x:fixed_diff_DIFFICULTY" for MoneroOcean
    password: 'x:fixed_diff_10000'
  },
  
  // Paths
  publicPath: path.join(__dirname, '..'),
  libPath: path.join(__dirname, '..', 'lib')
};

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
    
    // Login with combined worker name
    const loginMsg = {
      id: 1,
      method: 'login',
      params: {
        login: CONFIG.pool.wallet,
        pass: CONFIG.pool.workerName,
        agent: 'CombinedWebMiner/2.0'
      }
    };
    sharedPool.write(JSON.stringify(loginMsg) + '\n');
    console.log('[Pool] Sent login for combined worker: ' + CONFIG.pool.workerName);
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
    currentJob = null;
    recentJobs.clear();  // Clear old jobs on error
  });
  
  sharedPool.on('close', () => {
    console.log('[Pool] Disconnected, reconnecting in 5s...');
    poolConnected = false;
    poolAuthenticated = false;
    currentJob = null;
    recentJobs.clear();  // Clear old jobs on disconnect
    sharedPool = null;
    setTimeout(connectToPool, 5000);
  });
}

function handlePoolMessage(msg) {
  // Login response with job
  if (msg.id === 1 && msg.result && msg.result.job) {
    console.log('[Pool] ✅ Authenticated! Received first job');
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
  
  if (!poolAuthenticated) {
    console.log('[Pool] Cannot submit - not authenticated yet');
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
      id: '1',
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
        connected: miner.connected
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

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  
  if (url.pathname === '/proxy' || url.pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, req) => {
  const clientIP = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  const clientId = ++minerId;
  
  globalStats.totalConnections++;
  globalStats.activeMiners.set(clientId, {
    id: clientId,
    ip: clientIP,
    ws: ws,
    hashrate: 0,
    hashes: 0,
    connected: Date.now(),
    lastUpdate: Date.now()
  });
  
  console.log(`[Miner #${clientId}] Connected from ${clientIP} (${globalStats.activeMiners.size} active)`);
  
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
            <th>IP Address</th>
            <th>Status</th>
            <th>Shares</th>
            <th>Connected</th>
          </tr>
        </thead>
        <tbody id="minersTableBody">
          ${globalStats.activeMiners.size === 0 ? 
            '<tr><td colspan="5" style="color: #8b949e; text-align: center;">No miners connected yet</td></tr>' : 
            Array.from(globalStats.activeMiners.values()).map(m => `
          <tr>
            <td><span class="status"></span>#${m.id}</td>
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
          tbody.innerHTML = '<tr><td colspan="5" style="color: #8b949e; text-align: center;">No miners connected yet</td></tr>';
        } else {
          tbody.innerHTML = data.miners.list.map(m => 
            '<tr><td><span class="status"></span>#' + m.id + '</td><td>' + m.ip + '</td><td style="color: #3fb950;">● Mining</td><td>' + m.hashes + '</td><td>' + formatUptime(Math.floor((Date.now() - m.connected) / 1000)) + '</td></tr>'
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
