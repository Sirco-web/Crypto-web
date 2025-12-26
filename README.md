# Monero Web Miner

High-performance browser-based Monero (XMR) miner using CryptoNight algorithm.

## Features

- **Real CryptoNight Algorithm**: Implements Keccak/SHA-3 and memory-hard hashing
- **Stratum Protocol**: Full support for mining pool communication
- **Auto-Start**: Mining begins immediately upon user consent
- **Real-Time Stats**: Live hashrate, total hashes, and accepted shares
- **WebSocket Proxy**: Included bridge server for pool connectivity

## Quick Start

### 1. Start the Proxy Server

```bash
cd proxy
npm install
npm start
```

You should see:
```
==================================================
XMR Mining Proxy Server
==================================================
WebSocket: ws://localhost:8888
Target Pool: pool.supportxmr.com:3333
==================================================
[*] Proxy listening on port 8888
[*] Ready for connections...
```

### 2. Open the Miner

Open `index.html` in your web browser.

### 3. Start Mining

Click "Start Mining" in the consent dialog. Mining will begin automatically.

## Configuration

Edit `app.js` to change:
- `OWNER_WALLET` - Your Monero wallet address
- `POOL_URL` - WebSocket proxy URL

Edit `proxy/server.js` to change:
- `POOL_HOST` - Mining pool hostname
- `POOL_PORT` - Mining pool port

## Supported Pools

Any pool supporting Stratum protocol:
- pool.supportxmr.com
- xmrpool.eu
- monerohash.com
- minexmr.com

## Technical Details

- **Algorithm**: CryptoNight-Lite (1MB scratchpad)
- **Hashing**: Keccak-256 + memory-hard mixing
- **Protocol**: Stratum over WebSocket
