const net = require('net');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const WS_PORT = 8892;
const POOL_HOST = 'gulf.moneroocean.stream';  // MoneroOcean - excellent vardiff
const POOL_PORT = 10128;  // Low diff port for CPU mining
const AUTH_PASS = 'x';

// Path to lib files (relative to proxy folder)
const LIB_PATH = path.join(__dirname, '..', 'lib');

let stats = { clients: 0, totalHashes: 0, uptime: Date.now() };

// Simple HTTP server with static file serving for /miner/
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  // Serve miner files from /miner/ path (CoinHive expects this)
  if (req.url.startsWith('/miner/')) {
    const filename = req.url.replace('/miner/', '');
    const filePath = path.join(LIB_PATH, filename);
    
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filename);
      const contentTypes = {
        '.js': 'application/javascript',
        '.wasm': 'application/wasm',
        '.mem': 'application/octet-stream'
      };
      res.setHeader('Content-Type', contentTypes[ext] || 'application/octet-stream');
      res.writeHead(200);
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }
  
  if (req.url === '/stats') {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({
      clients: stats.clients,
      total_hashes: stats.totalHashes,
      uptime: (Date.now() - stats.uptime) / 1000
    }));
    return;
  }
  
  res.setHeader('Content-Type', 'text/html');
  res.writeHead(200);
  res.end(`
<!DOCTYPE html>
<html>
<head>
  <title>XMR Mining Proxy</title>
  <style>
    body { font-family: monospace; background: #1a1a2e; color: #6ee7ff; padding: 2rem; }
    h1 { color: #00ff88; }
    code { background: #000; padding: 0.5rem 1rem; display: block; margin: 1rem 0; border-radius: 4px; }
    .info { color: #ffaa00; }
  </style>
</head>
<body>
  <h1>⛏️ XMR Mining Proxy Server</h1>
  <p>WebSocket-to-Stratum proxy - CoinHive protocol compatible</p>
  
  <h2>Stats:</h2>
  <code>Clients: ${stats.clients} | Total Hashes: ${stats.totalHashes}</code>
  
  <h2>Connection:</h2>
  <code>WebSocket: ws://localhost:${WS_PORT}</code>
  <code>Pool: ${POOL_HOST}:${POOL_PORT}</code>
  
  <h2 class="info">⚠️ Web Interface:</h2>
  <p>Mining page runs on port 8080</p>
  
  <hr>
  <p style="color:#00ff88">Proxy Status: ✅ Running</p>
</body>
</html>
  `);
});

const wss = new WebSocket.Server({ noServer: true });

// Handle HTTP upgrade for WebSocket
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  
  if (pathname === '/proxy' || pathname === '/') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

console.log('='.repeat(50));
console.log('XMR Mining Proxy');
console.log('='.repeat(50));
console.log('WebSocket: ws://localhost:' + WS_PORT + '/proxy');
console.log('Info Page: http://localhost:' + WS_PORT);
console.log('Pool: ' + POOL_HOST + ':' + POOL_PORT);
console.log('='.repeat(50));

wss.on('connection', (ws, req) => {
    const clientIP = req.socket.remoteAddress;
    console.log('[+] Client connected from ' + clientIP);
    stats.clients++;
    
    const pool = new net.Socket();
    let buffer = '';
    let rpcId = 0;
    let workerId = null;
    let currentJobId = null;
    let hashes = 0;

    pool.connect(POOL_PORT, POOL_HOST, () => {
        console.log('[+] Pool connected for client');
    });

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            console.log('[>] Client:', msg.type);

            if (msg.type === 'auth') {
                let login = msg.params.site_key;
                if (msg.params.user) login += '.' + msg.params.user;
                rpcId++;
                pool.write(JSON.stringify({
                    id: rpcId,
                    jsonrpc: '2.0',
                    method: 'login',
                    params: { login, pass: AUTH_PASS, agent: 'CoinHive/1.0' }
                }) + '\n');
            }
            else if (msg.type === 'submit') {
                // Validate job_id matches
                if (msg.params.job_id !== currentJobId) {
                    console.log('[!] Stale share (job mismatch)');
                    return;
                }
                rpcId++;
                pool.write(JSON.stringify({
                    id: rpcId,
                    jsonrpc: '2.0',
                    method: 'submit',
                    params: {
                        id: workerId,
                        job_id: msg.params.job_id,
                        nonce: msg.params.nonce,
                        result: msg.params.result
                    }
                }) + '\n');
            }
        } catch (e) {
            console.error('[!] Parse error:', e.message);
        }
    });

    pool.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const msg = JSON.parse(line);
                console.log('[<] Pool:', msg.method || (msg.result ? 'result' : 'error'));

                // Login response
                if (msg.id === 1 && msg.result && msg.result.id) {
                    workerId = msg.result.id;
                    ws.send(JSON.stringify({ 
                        type: 'authed', 
                        params: { token: '', hashes: 0 } 
                    }));
                    
                    if (msg.result.job) {
                        currentJobId = msg.result.job.job_id;
                        ws.send(JSON.stringify({ 
                            type: 'job', 
                            params: msg.result.job 
                        }));
                    }
                }
                // New job
                else if (msg.method === 'job') {
                    currentJobId = msg.params.job_id;
                    ws.send(JSON.stringify({ 
                        type: 'job', 
                        params: msg.params 
                    }));
                }
                // Share accepted
                else if (msg.result && msg.result.status === 'OK') {
                    hashes++;
                    stats.totalHashes++;
                    ws.send(JSON.stringify({ 
                        type: 'hash_accepted', 
                        params: { hashes: hashes } 
                    }));
                    console.log('[✓] Share accepted! Total:', hashes);
                }
                // Error
                else if (msg.error) {
                    console.log('[✗] Pool error:', msg.error.message);
                    ws.send(JSON.stringify({ 
                        type: 'error', 
                        params: { error: msg.error.message } 
                    }));
                }
            } catch (e) {
                console.error('[!] Pool parse error:', e.message);
            }
        }
    });

    pool.on('error', (err) => {
        console.error('[!] Pool error:', err.message);
        ws.close();
    });
    
    pool.on('close', () => {
        console.log('[-] Pool closed');
        ws.close();
    });

    ws.on('close', () => {
        console.log('[-] Client disconnected');
        stats.clients--;
        pool.destroy();
    });

    ws.on('error', (err) => {
        console.error('[!] WebSocket error:', err.message);
        pool.destroy();
    });
});

server.listen(WS_PORT, () => {
    console.log('[*] Proxy running on port ' + WS_PORT);
});
