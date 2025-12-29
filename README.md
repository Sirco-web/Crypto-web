# ⛏️ XMR Web Miner

Browser-based Monero (XMR) miner using the **RandomX algorithm**. All connected browsers become ONE powerful worker on the pool!

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> ⚠️ **IMPORTANT:** All updates, bug fixes, and changes MUST be documented in **[FIXES.md](FIXES.md)**. See [Update Policy](#-update-policy) below.

## 🌟 Features

- **Combined Mining** - All connected miners share ONE pool connection = combined hashpower!
- **RandomX Algorithm** - Native Monero mining (rx/0) via WebAssembly
- **Auto-Tune** - Automatically detects hardware and optimizes thread count
- **MAX POWER Mode** - Use 100% of CPU for maximum hashrate
- **Real-time Dashboard** - Live stats at `/stats` showing all miners, combined hashrate, shares
- **Temperature Monitoring** - Native miners report CPU temp with auto-throttle/stop
- **Pool Confirmed Stats** - Shows pool-confirmed shares and wallet balance
- **Auto-Reconnect** - Handles disconnections gracefully
- **CORS Enabled** - No cross-origin errors
- **Cloud Ready** - Deploys to Koyeb, Render, Railway, etc.

## 📝 Update Policy

**ALL changes to this codebase MUST be documented in [FIXES.md](FIXES.md).**

When making any changes:
1. Add entry to **FIXES.md** with date, summary, why, and files changed
2. Bump version in `config.js` and `proxy/server.js`
3. Commit with message starting with version (e.g., `v4.3.4: Description`)
4. Push to GitHub (auto-deploys to Koyeb)

## 📁 Project Structure

```
Crypto-web/
├── index.html          # Main mining interface ⭐
├── index.js            # Bundled miner library (WRXMiner)
├── 178.js              # RandomX WASM Worker ⭐
├── styles.css          # UI styling
├── config.js           # Configuration (VERSION here!)
├── FIXES.md            # Changelog & Developer docs ⭐
│
├── lib/                # CryptoNight library (legacy)
│   ├── miner.min.js
│   ├── cryptonight-asmjs.min.js
│   └── cryptonight-asmjs.min.js.mem
│
├── proxy/              # Proxy Server (deploy this!) ⭐
│   ├── server.js       # Main server (VERSION here!)
│   └── package.json
│
├── native-miner/       # Native miner scripts
│   ├── miner.py        # Windows Python miner
│   ├── linux_miner.sh  # Linux bash miner
│   ├── ws_bridge.py    # WebSocket-to-Stratum bridge
│   └── setup_xmrig.sh  # XMRig installer
│
└── wasm/               # WASM build artifacts
```

## 🚀 Quick Start

### Local Development

```bash
cd proxy
npm install
npm start
```

Then open: http://localhost:8892/

### Using Docker

```bash
docker build -t xmr-miner ./proxy
docker run -p 8892:8892 xmr-miner
```

## ☁️ Deploy to Koyeb

1. Push to GitHub
2. Go to [Koyeb](https://app.koyeb.com)
3. Create new Web Service from your GitHub repo
4. Set:
   - **Build command**: `cd proxy && npm install`
   - **Run command**: `cd proxy && npm start`
   - **Port**: `8000` (or match your PORT env var)
5. Environment variables (optional):
   ```
   WALLET=your_xmr_wallet_address
   WORKER_NAME=your_worker_name
   POOL_HOST=gulf.moneroocean.stream
   POOL_PORT=10001
   ```

## ☁️ Deploy to Render

1. Create new Web Service
2. Connect your GitHub repo
3. Set:
   - **Root Directory**: `proxy`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. Add environment variables as needed

## 🔧 How It Works

### Architecture

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│   Browser 1  │  │   Browser 2  │  │   Browser N  │
│  (miner.html)│  │  (miner.html)│  │  (miner.html)│
│              │  │              │  │              │
│  RandomX     │  │  RandomX     │  │  RandomX     │
│  WASM Worker │  │  WASM Worker │  │  WASM Worker │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │ WebSocket       │                 │
       └─────────────────┼─────────────────┘
                         │
              ┌──────────▼──────────┐
              │    Proxy Server     │
              │    (server.js)      │
              │                     │
              │  • Manages miners   │
              │  • Single pool conn │
              │  • Broadcasts jobs  │
              │  • Submits shares   │
              └──────────┬──────────┘
                         │ TCP/Stratum
              ┌──────────▼──────────┐
              │    Mining Pool      │
              │   (MoneroOcean)     │
              └─────────────────────┘
```

### Why Combined Mining?

Instead of each browser appearing as a separate worker on the pool:
- ❌ 20 workers × 10 H/s = scattered, hard to track
- ✅ 1 worker × 200 H/s = combined, clean dashboard

### RandomX Job Flow

1. **Pool** sends job with `blob`, `target`, `seed_hash`, `height`, `algo`
2. **Proxy** broadcasts job to all connected browsers
3. **Worker (178.js)** uses `seed_hash` to initialize RandomX, mines against `blob`
4. **Worker** finds valid hash → submits `nonce` + `result` to proxy
5. **Proxy** forwards share to pool

## 📊 Endpoints

| Endpoint | Description |
|----------|-------------|
| `/` | Landing page |
| `/miner.html` | Main mining interface |
| `/stats` | Real-time dashboard |
| `/api/stats` | JSON API for stats |
| `/health` | Health check (200 OK) |
| `/proxy` | WebSocket for miners |

## ⚙️ Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 8892 | Server port |
| `WALLET` | (hardcoded) | XMR wallet address |
| `WORKER_NAME` | sirco-sub-pool-miners | Pool worker name |
| `POOL_HOST` | gulf.moneroocean.stream | Pool hostname |
| `POOL_PORT` | 10001 | Pool port (10001=auto-diff, 10128=high) |

### Pool Ports (MoneroOcean)

| Port | Difficulty | Recommended For |
|------|------------|-----------------|
| 10001 | Auto | Most users |
| 10004 | 10000 | Medium hashrate |
| 10016 | 160000 | High hashrate |
| 10128 | 1000000 | Very high hashrate |

## 🔴 Known Issues & Fixes

See **[FIXES.md](FIXES.md)** for detailed documentation on:
- All bugs fixed and their root causes
- Complete changelog from all commits
- How the codebase works internally
- Common issues and solutions
- API reference
- Development guide

### Recent Fixes (Dec 29, 2025 - v4.3.4)

| Issue | Cause | Fix |
|-------|-------|-----|
| OOM crashes on Windows | Too many RandomX workers | Hard cap of 4 workers (v4.3.2) |
| "Unauthenticated" errors | Pool session expiring | Keepalive pings every 30s (v4.3.0) |
| Miners behind NAT combined | IP-based identification | Client-generated unique IDs (v4.3.0) |
| "Low difficulty share" | Server overriding target | Use pool's actual target (v4.2.2) |
| Difficulty shows "-" | Missing config in API | Added config object (v4.3.3) |
| No temperature display | Native miners not reporting | Bridge sends status updates (v4.3.3) |

## 🛠️ Development

### Testing WebSocket

```javascript
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:8892/proxy');

ws.on('message', data => {
  console.log(JSON.parse(data));
});
```

### Adding Features

1. Read [FIXES.md](FIXES.md) first!
2. Understand the 3 job send paths
3. Test locally before deploying
4. Update documentation

## 📈 Performance Tips

1. **Use MAX POWER mode** for dedicated mining machines
2. **Auto-threads** works best for shared devices
3. **Lower throttle** = more hashing but higher CPU usage
4. **Use high-diff port** if combined hashrate > 1 KH/s

## 🔗 Links

- **Pool Dashboard**: [MoneroOcean](https://moneroocean.stream)
- **RandomX**: [GitHub](https://github.com/tevador/RandomX)
- **Original WebRandomX**: [Vectra/WebRandomX](https://github.com/AnyoneMiner/WebRandomX)

## 📜 License

MIT License - See [LICENSE](LICENSE)

## 🙏 Credits

- [WebRandomX](https://github.com/AnyoneMiner/WebRandomX) - Original RandomX web implementation
- [WRXProxy](https://github.com/AnyoneMiner/WRXProxy) - Proxy reference implementation
- [MoneroOcean](https://moneroocean.stream) - Mining pool
- [RandomX](https://github.com/tevador/RandomX) - Mining algorithm

---

**⚠️ Disclaimer**: Mining cryptocurrency uses significant CPU resources. Ensure you have permission before mining on shared systems. This project is for educational purposes.
