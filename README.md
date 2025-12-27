# ⛏️ XMR Web Miner

Browser-based Monero (XMR) miner with combined mining power. All connected browsers become ONE powerful worker on the pool!

## 🌟 Features

- **Combined Mining** - All connected miners share ONE pool connection = combined hashpower!
- **Auto-Tune** - Automatically detects hardware and optimizes settings
- **MAX POWER Mode** - Use 100% of CPU for maximum hashrate
- **Dashboard** - Real-time stats at `/stats` showing all miners, combined hashrate, shares
- **CORS Enabled** - No cross-origin errors
- **Koyeb/Render Ready** - Deploys easily to any Node.js platform

## 📁 Project Structure

```
Crypto-web/
├── index.html      # Mining frontend
├── styles.css      # Styles
├── lib/            # CryptoNight WASM mining library
│   ├── miner.min.js
│   ├── cryptonight.wasm
│   ├── cryptonight-asmjs.min.js
│   └── cryptonight-asmjs.min.js.mem
└── proxy/          # Server (deploy this!)
    ├── server.js   # Combined proxy + web server
    └── package.json
```

## 🚀 Quick Start (Local)

```bash
cd proxy
npm install
npm start
```

Then open: http://localhost:8892

## ☁️ Deploy to Koyeb

1. Push to GitHub
2. Go to [Koyeb](https://koyeb.com)
3. Create new Web Service from your GitHub repo
4. Set:
   - **Build command**: `cd proxy && npm install`
   - **Run command**: `cd proxy && npm start`
   - **Port**: `8892`
5. Set environment variables (optional):
   - `WALLET` - Your XMR wallet address
   - `WORKER_NAME` - Worker name on pool
   - `POOL_HOST` - Pool address (default: gulf.moneroocean.stream)
   - `POOL_PORT` - Pool port (default: 10128)

## ☁️ Deploy to Render

1. Create new Web Service
2. Connect your GitHub repo
3. Set:
   - **Root Directory**: `proxy`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. Environment variables same as above

## 📊 Endpoints

| Endpoint | Description |
|----------|-------------|
| `/` | Mining interface |
| `/stats` | Dashboard with all miners & combined stats |
| `/api/stats` | JSON API for stats |
| `/health` | Health check for monitoring |
| `/proxy` | WebSocket endpoint for miners |

## ⚙️ Configuration

Edit `proxy/server.js` or use environment variables:

```javascript
const CONFIG = {
  port: process.env.PORT || 8892,
  pool: {
    host: process.env.POOL_HOST || 'gulf.moneroocean.stream',
    port: parseInt(process.env.POOL_PORT) || 10128,
    wallet: process.env.WALLET || 'YOUR_WALLET_HERE',
    workerName: process.env.WORKER_NAME || 'CombinedWebMiners'
  }
};
```

## 💡 How Combined Mining Works

Instead of each browser connecting separately to the pool (appearing as 20 different workers), ALL browsers connect to YOUR proxy. The proxy maintains ONE connection to the pool and submits shares on behalf of all miners.

Pool sees: **1 worker with 200 H/s** (combined)
Not: **20 workers with 10 H/s each**

This means:
- Cleaner pool dashboard
- All hashpower combined under one worker name
- Easier to track earnings

## 📜 License

MIT
