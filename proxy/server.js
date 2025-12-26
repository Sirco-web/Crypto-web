const net = require('net');
const http = require('http');
const WebSocket = require('ws');

// Configuration
const WS_PORT = 8888;
const POOL_HOST = 'pool.supportxmr.com';
const POOL_PORT = 3333;

// Create HTTP server for WebSocket upgrade
const server = http.createServer();
const wss = new WebSocket.Server({ server });

console.log('='.repeat(50));
console.log('XMR Mining Proxy Server');
console.log('='.repeat(50));
console.log(`WebSocket: ws://localhost:${WS_PORT}`);
console.log(`Target Pool: ${POOL_HOST}:${POOL_PORT}`);
console.log('='.repeat(50));

wss.on('connection', (ws, req) => {
    const clientIP = req.socket.remoteAddress;
    console.log(`[+] New miner connected from ${clientIP}`);
    
    // Connect to the real mining pool
    const pool = new net.Socket();
    let poolConnected = false;
    let buffer = '';
    
    pool.connect(POOL_PORT, POOL_HOST, () => {
        console.log(`[+] Connected to pool for ${clientIP}`);
        poolConnected = true;
    });
    
    // Browser -> Pool
    ws.on('message', (data) => {
        if (!poolConnected) {
            console.log(`[!] Pool not ready, buffering message`);
            return;
        }
        const msg = data.toString();
        console.log(`[>] Browser -> Pool: ${msg.substring(0, 100)}...`);
        pool.write(msg);
        if (!msg.endsWith('\n')) pool.write('\n');
    });
    
    // Pool -> Browser
    pool.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete line in buffer
        
        for (const line of lines) {
            if (line.trim()) {
                console.log(`[<] Pool -> Browser: ${line.substring(0, 100)}...`);
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(line);
                }
            }
        }
    });
    
    pool.on('error', (err) => {
        console.error(`[!] Pool error: ${err.message}`);
        ws.close();
    });
    
    pool.on('close', () => {
        console.log(`[-] Pool connection closed for ${clientIP}`);
        ws.close();
    });
    
    ws.on('close', () => {
        console.log(`[-] Miner disconnected: ${clientIP}`);
        pool.destroy();
    });
    
    ws.on('error', (err) => {
        console.error(`[!] WebSocket error: ${err.message}`);
        pool.destroy();
    });
});

server.listen(WS_PORT, () => {
    console.log(`[*] Proxy listening on port ${WS_PORT}`);
    console.log('[*] Ready for connections...');
});
