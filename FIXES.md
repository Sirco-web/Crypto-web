# 🔧 Fixes, Architecture & Developer Guide

This document explains all fixes applied to the XMR Web Miner, how the system works, and provides guidance for future developers/AIs to understand and improve the codebase.

---

## 📋 Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Critical Fixes Applied](#critical-fixes-applied)
3. [File Structure & Responsibilities](#file-structure--responsibilities)
4. [Data Flow](#data-flow)
5. [Common Issues & Solutions](#common-issues--solutions)
6. [API Reference](#api-reference)
7. [Development Guide](#development-guide)

---

## 🏗️ Architecture Overview

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Browser #1    │     │   Browser #2    │     │   Browser #N    │
│   (miner.html)  │     │   (miner.html)  │     │   (miner.html)  │
│                 │     │                 │     │                 │
│  ┌───────────┐  │     │  ┌───────────┐  │     │  ┌───────────┐  │
│  │  178.js   │  │     │  │  178.js   │  │     │  │  178.js   │  │
│  │ (Worker)  │  │     │  │ (Worker)  │  │     │  │ (Worker)  │  │
│  │ RandomX   │  │     │  │ RandomX   │  │     │  │ RandomX   │  │
│  │  WASM     │  │     │  │  WASM     │  │     │  │  WASM     │  │
│  └─────┬─────┘  │     │  └─────┬─────┘  │     │  └─────┬─────┘  │
└────────┼────────┘     └────────┼────────┘     └────────┼────────┘
         │ WebSocket             │ WebSocket             │ WebSocket
         └───────────────────────┼───────────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │     Proxy Server        │
                    │    (server.js)          │
                    │                         │
                    │  - Manages all miners   │
                    │  - Single pool conn     │
                    │  - Broadcasts jobs      │
                    │  - Submits shares       │
                    └────────────┬────────────┘
                                 │ TCP Socket
                    ┌────────────▼────────────┐
                    │    Mining Pool          │
                    │  (MoneroOcean)          │
                    │                         │
                    │  gulf.moneroocean.stream│
                    └─────────────────────────┘
```

### Key Concepts

1. **Combined Mining**: All browsers connect to ONE proxy which maintains ONE pool connection
2. **RandomX Algorithm**: Monero's mining algorithm (rx/0) - requires `seed_hash` for initialization
3. **WebSocket Protocol**: Browser ↔ Proxy communication
4. **Stratum Protocol**: Proxy ↔ Pool communication (JSON-RPC over TCP)

---

## 🔴 Critical Fixes Applied

### Fix #1: Missing `seed_hash` in Job Broadcast (December 27, 2025)

**Error**: 
```
Uncaught TypeError: Cannot read properties of undefined (reading 'length')
    at h.hexToBytes (178.js:1:2617)
    at h.setJob (178.js:1:3363)
```

**Root Cause**: The RandomX WASM worker (`178.js`) requires `seed_hash` to initialize the RandomX algorithm. The proxy was receiving complete job data from the pool but only forwarding partial data to browsers.

**Affected Code Locations** (3 places in `proxy/server.js`):

1. **`broadcastJob()` function** (~line 405)
   - Used when pool sends new jobs via `method: 'job'`
   
2. **Miner connection handler** (~line 1331)
   - Sends current job when a new browser connects
   
3. **Auth request handler** (~line 1354)
   - Sends job when browser sends `type: 'auth'`

**The Fix**:

```javascript
// BEFORE (broken):
ws.send(JSON.stringify({
  type: 'job',
  params: {
    job_id: currentJob.job_id,
    blob: currentJob.blob,
    target: currentJob.target
  }
}));

// AFTER (fixed):
ws.send(JSON.stringify({
  type: 'job',
  params: {
    job_id: currentJob.job_id,
    blob: currentJob.blob,
    target: currentJob.target,
    seed_hash: currentJob.seed_hash,  // REQUIRED for RandomX
    height: currentJob.height,         // Block height
    algo: currentJob.algo || 'rx/0'    // Algorithm identifier
  }
}));
```

**Why This Matters**: The `hexToBytes()` function in the worker tries to convert `seed_hash` from hex string to bytes. If `seed_hash` is undefined, calling `.length` on it throws the error.

**Commits**:
- `5e7fe25` - Initial fix to `broadcastJob()`
- `2819d65` - Complete fix for all 3 job send paths

---

## 📁 File Structure & Responsibilities

### Frontend Files (Root Directory)

| File | Purpose |
|------|---------|
| `index.html` | Main entry point - redirects or shows basic UI |
| `miner.html` | **Main mining interface** - dashboard, controls, stats display |
| `index.js` | Bundled miner library (minified) - contains `WRXMiner` class |
| `178.js` | **RandomX WASM Worker** - actual mining happens here |
| `styles.css` | UI styling |
| `config.js` | Configuration (wallet, proxy URL, pool settings) |

### Worker File (`178.js`) - Critical Understanding

This is a **minified Web Worker** that runs the RandomX algorithm in WebAssembly. Key methods:

```javascript
// Pseudocode of what 178.js does internally:
class RandomXWorker {
  hexToBytes(hexString) {
    // Converts hex string to Uint8Array
    // THROWS ERROR if hexString is undefined!
    const bytes = new Uint8Array(hexString.length / 2);
    // ...
  }
  
  setJob(job) {
    // Called when new job received
    const blobBytes = this.hexToBytes(job.blob);        // 152 chars
    const seedBytes = this.hexToBytes(job.seed_hash);   // 64 chars - REQUIRED!
    const targetBytes = this.hexToBytes(job.target);    // 8 chars
    
    // Initialize RandomX with seed_hash
    this.initRandomX(seedBytes);
    
    // Start mining
    this.mine(blobBytes, targetBytes);
  }
  
  onMessage(event) {
    // Receives job from main thread
    this.setJob(event.data);
  }
}
```

### Proxy Server (`proxy/server.js`)

2300+ line Node.js server handling:

| Section | Lines (approx) | Purpose |
|---------|----------------|---------|
| Configuration | 1-100 | Pool settings, wallet, ports |
| Pool Connection | 200-400 | TCP connection to mining pool |
| Job Handling | 400-450 | `handlePoolMessage()`, `broadcastJob()` |
| WebSocket Server | 1200-1450 | Browser connections, message routing |
| Dashboard | 500-800 | `/stats` page, API endpoints |
| Auto-difficulty | 800-1000 | Hashrate-based difficulty adjustment |

---

## 🔄 Data Flow

### 1. Pool → Proxy (Stratum Protocol)

Pool sends jobs via JSON-RPC:

```json
// Login response with first job
{
  "id": 1,
  "result": {
    "id": "worker_id_12345",
    "job": {
      "job_id": "abc123",
      "blob": "0e0e...(152 hex chars)",
      "target": "b88d0600",
      "seed_hash": "491c63...(64 hex chars)",
      "height": 3574950,
      "algo": "rx/0"
    }
  }
}

// New job notification
{
  "method": "job",
  "params": {
    "job_id": "def456",
    "blob": "...",
    "target": "...",
    "seed_hash": "...",
    "height": 3574951,
    "algo": "rx/0"
  }
}
```

### 2. Proxy → Browser (WebSocket)

Proxy forwards to miners:

```json
// Authentication confirmed
{ "type": "authed", "params": { "hashes": 0 } }

// Job to mine
{
  "type": "job",
  "params": {
    "job_id": "abc123",
    "blob": "...",
    "target": "...",
    "seed_hash": "...",    // ⚠️ CRITICAL - must be included!
    "height": 3574950,
    "algo": "rx/0"
  }
}

// Share accepted
{ "type": "hash_accepted", "params": { "hashes": 1 } }
```

### 3. Browser → Proxy (WebSocket)

Browser sends:

```json
// Submit found share
{
  "type": "submit",
  "params": {
    "job_id": "abc123",
    "nonce": "a1b2c3d4",
    "result": "0000000..."
  }
}

// Hashrate update (optional)
{ "type": "hashrate", "params": { "rate": 25.5 } }

// Keep-alive
{ "type": "ping" }
```

### 4. Proxy → Pool (Stratum)

```json
// Submit share
{
  "id": 2,
  "method": "submit",
  "params": {
    "id": "worker_id_12345",
    "job_id": "abc123",
    "nonce": "a1b2c3d4",
    "result": "0000000..."
  }
}
```

---

## ⚠️ Common Issues & Solutions

### Issue: "Cannot read properties of undefined (reading 'length')"

**Cause**: Job data missing required fields (`blob`, `seed_hash`, or `target`)

**Solution**: Check ALL places that send jobs to miners and ensure they include:
- `job_id`
- `blob`
- `target`
- `seed_hash` ← Most commonly missing!
- `height`
- `algo`

**Debug**: Add logging to see what's being sent:
```javascript
console.log('Sending job:', JSON.stringify(msg.params));
```

### Issue: Mining but 0 Accepted Shares

**Possible Causes**:
1. **Wrong difficulty** - Target too hard for hashrate
2. **Stale shares** - Job changed before share submitted
3. **Invalid nonce** - Worker computing incorrectly

**Solution**: 
- Use auto-difficulty (port 10001 or 10128)
- Check pool logs for rejection reasons
- Verify worker is using correct algo (rx/0)

### Issue: WebSocket Disconnects

**Causes**:
1. Proxy restart/redeploy
2. Network issues
3. Browser tab inactive (throttled)

**Solution**: The miner has auto-reconnect built in:
```javascript
this._autoReconnect = true;
this._reconnectRetry = 3; // seconds
```

### Issue: Pool Connection Drops

**Cause**: Pool might suspend IP for too many invalid shares

**Solution**: Built-in suspension handler with 11-minute cooloff:
```javascript
function handleIPSuspension() {
  globalStats.suspended = true;
  globalStats.suspensionEndTime = Date.now() + (11 * 60 * 1000);
  // ...
}
```

---

## 📡 API Reference

### WebSocket Messages (Browser ↔ Proxy)

#### From Proxy to Browser

| Type | Params | Description |
|------|--------|-------------|
| `authed` | `{ hashes: number }` | Authentication confirmed |
| `job` | `{ job_id, blob, target, seed_hash, height, algo }` | New job to mine |
| `hash_accepted` | `{ hashes: number }` | Share accepted by pool |
| `error` | `{ error: string }` | Error message |
| `banned` | `{ banned: boolean }` | IP banned by pool |
| `command` | `{ action: string, ... }` | Control commands |
| `pong` | `{}` | Response to ping |

#### From Browser to Proxy

| Type | Params | Description |
|------|--------|-------------|
| `auth` | `{ user?: string }` | Request authentication |
| `submit` | `{ job_id, nonce, result }` | Submit found share |
| `hashrate` | `{ rate: number }` | Report current hashrate |
| `info` | `{ cores, threads, status }` | Report miner info |
| `ping` | `{}` | Keep-alive ping |

### HTTP Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Main mining page |
| `/miner.html` | GET | Alternative mining page |
| `/stats` | GET | Dashboard HTML |
| `/api/stats` | GET | Stats JSON |
| `/health` | GET | Health check (returns 200) |
| `/proxy` | WS | WebSocket endpoint |

---

## 🛠️ Development Guide

### Local Development

```bash
cd proxy
npm install
npm start
# Server runs on http://localhost:8892
```

### Testing WebSocket Connection

```javascript
// Quick test script
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:8892/proxy');

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  console.log('Received:', msg.type, msg.params);
});

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'auth', params: {} }));
});
```

### Adding New Features

1. **New WebSocket message type**: 
   - Add handler in `ws.on('message', ...)` block (~line 1344)
   - Document in this file

2. **New HTTP endpoint**:
   - Add route before the catch-all static file handler
   - Example: `if (pathname === '/myendpoint') { ... }`

3. **Modify job handling**:
   - ⚠️ Update ALL 3 job send locations!
   - `broadcastJob()` function
   - Connection handler
   - Auth request handler

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 8892 | Server port |
| `WALLET` | (hardcoded) | XMR wallet address |
| `WORKER_NAME` | sirco-sub-pool-miners | Pool worker name |
| `POOL_HOST` | gulf.moneroocean.stream | Pool hostname |
| `POOL_PORT` | 10001 | Pool port |

### Debugging Tips

1. **Enable verbose logging**:
   ```javascript
   // Add to handlePoolMessage:
   console.log('[Pool] Raw message:', JSON.stringify(msg));
   ```

2. **Test with local proxy**:
   ```javascript
   // In config.js, temporarily change:
   wsServer: 'ws://localhost:8892'
   ```

3. **Check browser DevTools**:
   - Network tab → WS → Messages
   - Console for errors

### Code Quality Checklist

When making changes, verify:

- [ ] All 3 job send paths include required fields
- [ ] WebSocket messages are valid JSON
- [ ] Error handling for edge cases
- [ ] Logging for debugging
- [ ] No hardcoded values that should be configurable

---

## 📚 References

- [RandomX Algorithm](https://github.com/tevador/RandomX)
- [Stratum Protocol](https://en.bitcoin.it/wiki/Stratum_mining_protocol)
- [MoneroOcean Pool](https://moneroocean.stream)
- [WebAssembly](https://webassembly.org/)

---

## 📝 Complete Changelog

### v2.5.0 - December 27, 2025

#### 🎯 Major Fixes

| Commit | Fix | Description |
|--------|-----|-------------|
| `14c1e84` | **Stop Button** | Added working stop/start button controls |
| `581b2f7` | **Hashrate Reporting** | Fixed dashboard showing 0 hashrate/workers |
| `2819d65` | **seed_hash (Complete)** | Fixed ALL 3 job send paths for RandomX |
| `5e7fe25` | **seed_hash (Initial)** | Added seed_hash to broadcastJob() |
| `3525d1f` | **Auth State** | Fixed unauthenticated share submission |
| `060cd40` | **Dead Connections** | More aggressive cleanup of stale connections |

#### 🚀 Features Added

| Commit | Feature | Description |
|--------|---------|-------------|
| `14c1e84` | **Server Commands** | Full support for stop/start/setThreads/kick/refresh |
| `581b2f7` | **RandomX Migration** | index.html now redirects to miner.html |
| `41f5175` | **IP Suspension Handler** | 11-minute cooloff when pool suspends IP |
| `afb028f` | **Version Tracking** | v2.5.0 tracking in server, client, and Python miner |
| `d1ad5c7` | **Auto/Manual Difficulty** | Smart difficulty mode with auto port selection |
| `8e2bdde` | **Manage Miner Modal** | Remote thread control, start/stop per miner |
| `a73f65b` | **Remote Control** | /control WebSocket for owner commands |
| `2e53bd5` | **Python Native Miner** | Windows/Linux native miner alternative |
| `7d5e664` | **Enhanced Owner Panel** | Session tokens, rate limiting, more stats |
| `1ae0038` | **Owner Panel** | PIN auth, wallet display, MoneroOcean link |
| `bc31d37` | **Stale Share Handling** | Keep last 10 jobs for slightly stale shares |

#### 🔧 Configuration Changes

| Commit | Change | Description |
|--------|--------|-------------|
| `21eef18` | **Auto-Difficulty** | Removed fixed difficulty, let pool adjust |
| `d89a5b3` | **Low Diff Port** | Switched to port 10001 for faster shares |
| `3ff6593` | **Worker Name** | Changed to 'sirco-sub-pool-miners' |
| `090f0e5` | **Fixed Difficulty** | Set 10000 for faster finding |
| `52b81c3` | **Proxy URL** | Hardcoded Koyeb proxy URL |
| `904ade9` | **WebSocket Path** | Added /proxy path to URL |

#### 🐛 Bug Fixes

| Commit | Fix | Description |
|--------|-----|-------------|
| `e89210c` | UI IDs | Fixed miner UI element IDs and uptime counter |
| `7af3f83` | Init Logic | Fixed Vectra miner initialization |
| `059dd1a` | GitHub Pages | Configured to ignore backend files |
| `9d729bd` | Git Submodules | Converted to regular directories |
| `06369f0` | Error Fix | General error handling |
| `bf5921c` | Misc Fix | Various fixes |

#### 📚 Documentation

| Commit | Change | Description |
|--------|--------|-------------|
| `e66b020` | **FIXES.md** | Created comprehensive developer guide |
| `e66b020` | **README.md** | Updated with architecture and usage |

---

### December 26, 2025 (Initial Development)

| Commit | Description |
|--------|-------------|
| `4145924` | Created CNAME for custom domain |
| `efff331` | Updated CNAME configuration |
| `0095326` | Near-complete v2 implementation |
| `5da6554` | Almost complete implementation |
| `06d6500` | Various fixes |
| `13c6b2c` | Started development |

### December 25, 2025

| Commit | Description |
|--------|-------------|
| `0833765` | Initial commit - Project started |

---

## 🔍 Quick Reference: All Fix Locations

### proxy/server.js

| Line Range | What | Fix Applied |
|------------|------|-------------|
| ~405 | `broadcastJob()` | Added seed_hash, height, algo |
| ~1331 | Connection handler | Added seed_hash, height, algo |
| ~1354 | Auth handler | Added seed_hash, height, algo |
| ~365 | `handleIPSuspension()` | 11-minute cooloff logic |
| ~500+ | Dashboard routes | Enhanced stats, version info |
| ~1200+ | WebSocket handlers | Control commands, info tracking |

### miner.html

| Section | What | Fix Applied |
|---------|------|-------------|
| Stop button | `onclick` | Calls stopVectraMiner() |
| Start button | `onclick` | Calls startVectraMiner() |
| infoSocket | WebSocket | Reports hashrate every 5s |
| handleRemoteCommand() | Function | Handles all server commands |
| sessionStorage | State | Remembers stopped state |

### index.html

| Change | Description |
|--------|-------------|
| Redirect | Now redirects to miner.html (RandomX) |
| Old code | Removed 800+ lines of CryptoNight miner |

---

## 🔄 Server ↔ Client Protocol

### Server → Client Messages

| Type | Fields | Description |
|------|--------|-------------|
| `authed` | `{ hashes }` | Authentication success |
| `job` | `{ job_id, blob, target, seed_hash, height, algo }` | New mining job |
| `hash_accepted` | `{ hashes }` | Share accepted |
| `error` | `{ error }` | Error message |
| `banned` | `{ banned }` | IP banned |
| `command` | `{ action, reason?, threads? }` | Control command |

### Client → Server Messages

| Type | Fields | Description |
|------|--------|-------------|
| `auth` | `{ user? }` | Request authentication |
| `submit` | `{ job_id, nonce, result }` | Submit share |
| `info` | `{ cores, threads, hashrate, status, clientVersion }` | Report stats |
| `identify` | `{ clientVersion }` | Identify as control client |

### Command Actions

| Action | Effect | Triggered By |
|--------|--------|--------------|
| `stop` | Stop mining | Owner panel or IP suspension |
| `start` | Start mining | Owner panel |
| `setThreads` | Change thread count | Manage miner modal |
| `kick` | Disconnect | Owner panel |
| `refresh` | Reload page | Owner panel |

---

*Last updated: December 28, 2025*

---

## 🚀 Major Update v3.0.0 (December 28, 2025)

### New Wallet Address
Updated wallet across all files:
```
42C9fVZdev5ZW7k6NmNGECVEpy2sCkA8JMpA1i2zLxUwCociGC3VzAbJ5WoMUFp3qeSqpCuueTvKgXZh8cnkbj957aBZiAB
```

Files updated:
- `config.js`
- `proxy/server.js`
- `native-miner/miner.py`
- `native-miner/linux_miner.sh`

---

### Fix #9: Windows Python Native Miner Complete Rewrite

**File**: `native-miner/miner.py`

**Old Issues**:
- Basic functionality, no error handling
- No connection check before mining
- No CPU temperature monitoring
- No XMRig auto-download
- Plain text output

**New Features**:
- **ASCII Banner UI**: Beautiful terminal banner with version info
- **Connection Check**: Tests connectivity to MoneroOcean before starting
- **CPU Temperature Monitoring**: 
  - Uses WMI (requires admin) or psutil
  - Throttles at 80°C (reduces to 50% threads)
  - Stops at 90°C (pauses mining)
  - Resumes at 70°C
- **Auto XMRig Download**: Downloads and extracts XMRig 6.21.1 automatically
- **Colorized Output**: Uses colorama for beautiful colored logging
- **Full Power Default**: Uses all CPU cores by default
- **Hashrate Display**: Shows real-time hashrate in terminal
- **Client Version**: Now reports v3.0.0 to match server

---

### Fix #10: New Linux Miner for ANY Distribution

**File**: `native-miner/linux_miner.sh` (NEW)

**Features**:
- **Universal Compatibility**: Works on Ubuntu, Debian, Fedora, CentOS, RHEL, Arch, Manjaro, openSUSE, Alpine, and generic Linux
- **Architecture Detection**: Supports x64 (amd64) and ARM64 (aarch64)
- **Package Manager Detection**: Auto-uses apt, dnf, yum, pacman, zypper, or apk
- **Connection Check**: Tests MoneroOcean connectivity before mining
- **CPU Temperature Monitoring**:
  - Multiple methods: `sensors`, `/sys/class/thermal`, `/sys/class/hwmon`, `vcgencmd` (Raspberry Pi)
  - Same throttle/stop thresholds as Windows (80°C/90°C)
- **Auto XMRig Download**: Downloads correct binary for architecture
- **Beautiful Terminal UI**: ASCII art banner, colored output
- **Full Power Default**: Uses all CPU cores
- **Hashrate Reporting**: Parses XMRig output for live hashrate

**Usage**:
```bash
chmod +x linux_miner.sh
./linux_miner.sh
```

---

### Fix #11: Activity Log on Dashboard

**File**: `proxy/server.js`

**New Feature**: Dashboard now shows a live activity log with:
- ✅ Share accepted events
- ❌ Share rejected events
- 🎉 Block found events
- 📌 Server events

**Implementation**:
- Added `activityLog` array (max 100 entries)
- Added `addLogEntry(type, message, data)` function
- Added `/api/activity-log` endpoint
- Dashboard auto-refreshes log every 3 seconds

---

### Fix #12: Pool Stats from MoneroOcean API

**File**: `proxy/server.js`

**New Feature**: Server fetches wallet stats from MoneroOcean on startup and displays on dashboard:
- 💰 Balance
- 💵 Total Paid
- 📈 Pool Hashrate
- 🕐 Last Share Time

**Implementation**:
- Added `fetchPoolStats()` function using MoneroOcean API
- Added `/api/pool-stats` endpoint
- Dashboard shows pool stats section with 30-second refresh
- Stats logged on server startup

---

### Fix #13: Full Power Mining by Default

**File**: `index.html`

**Change**: Web miner now starts at full power (all CPU cores) by default.

```javascript
// BEFORE:
let maxPowerEnabled = false;

// AFTER:
let maxPowerEnabled = true; // Full power by default!
```

Users can still reduce power via owner panel, but default is maximum hashrate.

---

### Fix #14: Block Found Detection

**File**: `proxy/server.js`

**New Feature**: Server now detects when a block is found by the pool.

```javascript
// Block found check
else if (msg.id && msg.result && msg.result.status === 'BLOCK') {
  globalStats.blocksFound++;
  console.log(`[Pool] 🎉🎉🎉 BLOCK FOUND! Total: ${globalStats.blocksFound}`);
  addLogEntry('block_found', `🎉 BLOCK FOUND! Block #${globalStats.blocksFound}`, { 
    total: globalStats.blocksFound 
  });
  broadcastToMiners({ type: 'block_found', params: { blocks: globalStats.blocksFound } });
}
```

---

### Fix #15: Hashrate Display Not Showing (Element ID Mismatch)

**Date**: 2025-12-28

**File**: `index.html`

**Problem**: Hashrate, total hashes, accepted shares, and worker count were not displaying on the web client.

**Root Cause**: The HTML elements used different IDs than what the JavaScript was targeting:

| HTML Element ID | JavaScript Was Using | Status |
|-----------------|----------------------|--------|
| `rate` | `hashrate` | ❌ Mismatch |
| `total` | `totalHashes` | ❌ Mismatch |
| `accepted` | `acceptedShares` | ❌ Mismatch |
| `thread` | `threads` | ❌ Mismatch |

**The Fix**: Updated all JavaScript references to use the correct HTML element IDs:

```javascript
// BEFORE (broken - using wrong IDs):
function updateStats() {
  $('hashrate').textContent = fmtNum(currentHashrate);
  $('totalHashes').textContent = fmtNum(totalHashes);
  $('acceptedShares').textContent = totalAccepted;
  $('threads').textContent = workers.length;
  // ... sidebar updates
}

// AFTER (fixed - using correct IDs):
function updateStats() {
  // Main stats display (HTML IDs: rate, total, accepted, thread)
  $('rate').textContent = fmtNum(currentHashrate) + ' H/s';
  $('total').textContent = fmtNum(totalHashes);
  $('accepted').textContent = totalAccepted;
  $('thread').textContent = workers.length;
  
  // Sidebar stats
  $('sidebarHashrate').textContent = fmtNum(currentHashrate) + ' H/s';
  $('sidebarTotalHashes').textContent = fmtNum(totalHashes);
  $('sidebarAccepted').textContent = totalAccepted;
  $('sidebarThreads').textContent = workers.length;
  // ...
}
```

**Files Modified**:
- `index.html` lines 216-232 - `updateStats()` function
- `index.html` line 362 - `startWorkers()` function
- `index.html` line 424 - `stopMining()` function
- `index.html` line 585 - `loadMinerScript()` auto-start
- `index.html` line 1028 - Stats sync interval

**Why This Happened**: The code was likely refactored at some point, changing the HTML IDs but not updating all the JavaScript references.

**How to Prevent**: 
- Use consistent naming conventions
- Define element IDs as constants
- Use TypeScript or JSDoc for type checking

---

## 📁 Updated File Structure

```
native-miner/
├── miner.py              # Windows Python miner (v3.0.0) - REWRITTEN
├── linux_miner.sh        # Linux universal miner (v3.0.0) - NEW
├── setup.bat             # Windows XMRig setup
├── start_miner.bat       # Windows quick start
├── setup_xmrig.sh        # Linux XMRig setup
├── start_xmrig.sh        # Linux quick start
└── README.md             # Documentation
```

---

## 🌡️ Temperature Monitoring Thresholds

| Temperature | Action |
|-------------|--------|
| < 70°C | Full power |
| 70-79°C | Normal operation |
| 80-89°C | ⚠️ Throttle to 50% threads |
| ≥ 90°C | 🛑 Stop mining completely |
| < 70°C after stop | ▶️ Resume mining |

---

## 🔗 API Endpoints (Updated)

| Endpoint | Description |
|----------|-------------|
| `/api/stats` | Mining stats (miners, shares, hashrate) |
| `/api/activity-log` | Last 100 activity events |
| `/api/pool-stats` | MoneroOcean wallet stats |
| `/health` | Server health check |
| `/stats` | Dashboard HTML |
| `/owner` | Owner control panel |

---

## 🔧 Version History

| Version | Date | Changes |
|---------|------|---------|
| 3.1.0 | 2025-12-28 | **Fix #15**: Fixed hashrate display - element ID mismatch (`hashrate`→`rate`, `threads`→`thread`, etc.) |
| 3.0.0 | 2025-12-28 | New wallet, native miners rewrite, activity log, pool stats, full power default |
| 2.5.0 | 2025-12-27 | Miner status colors, stopped miner display |
| 2.4.0 | 2025-12-27 | Consent popup, Vectra miner integration |
| 2.0.0 | 2025-12-27 | Fixed seed_hash, hashrate reporting |
| 1.0.0 | 2025-12-27 | Initial proxy server |

---
