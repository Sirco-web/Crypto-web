# Native XMR Miners

Native miners that connect through the proxy server. All miners (browser + native) are combined into ONE pool worker!

## Available Miners

1. **Windows** - `miner.py` (Python + XMRig)
2. **Linux** - `linux_miner.sh` (Bash + XMRig)

Both miners use the `ws_bridge.py` WebSocket-to-Stratum bridge to connect through the proxy.

## Requirements

### Windows
- Python 3.7+
- Internet connection

### Linux
- Bash
- Python 3 (for bridge)
- Internet connection

## Quick Start

### Windows
```cmd
python miner.py
```

### Linux
```bash
chmod +x linux_miner.sh
./linux_miner.sh
```

## How It Works

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│    XMRig     │────▶│  ws_bridge   │────▶│    Proxy     │────▶│   Pool       │
│   (Mining)   │     │  (Local)     │     │  (Koyeb)     │     │ (MoneroOcean)│
│   Port 3333  │     │  WebSocket   │     │   /proxy     │     │              │
└──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
     Stratum              WS                  WS                   Stratum
```

1. **XMRig** runs locally and connects to the bridge on `127.0.0.1:3333`
2. **ws_bridge.py** converts Stratum protocol to WebSocket
3. Bridge connects to the proxy server via WebSocket (`wss://...koyeb.app/proxy`)
4. **Proxy server** combines all miners (browser + native) into one worker
5. All shares go to MoneroOcean pool

## Features

### ✅ Combined Mining
Your hashrate is combined with all other miners connected to the proxy.

### ✅ Owner Panel Control
Native miners appear in the Owner Panel dashboard and can be:
- Monitored (see hashrate, shares)
- Disconnected (kick)

### ✅ CPU Temperature Monitoring
Automatically throttles or stops mining if CPU gets too hot:
- 80°C: Throttle to 50% threads
- 90°C: Stop mining completely
- 70°C: Resume full power

### ✅ Auto XMRig Download
Automatically downloads and installs XMRig 6.21.1

### ✅ Full Power by Default
Uses all CPU cores for maximum hashrate

## Configuration

Edit the configuration at the top of each miner:

### miner.py (Windows)
```python
PROXY_HOST = "your-proxy.koyeb.app"
WORKER_NAME = "windows-miner"
TEMP_THROTTLE = 80
TEMP_STOP = 90
```

### linux_miner.sh
```bash
PROXY_HOST="your-proxy.koyeb.app"
WORKER_NAME="linux-miner"
TEMP_THROTTLE=80
TEMP_STOP=90
```

## Troubleshooting

### "Bridge failed to start"
- Make sure Python 3 is installed
- Run: `pip install websockets`

### "Cannot connect to proxy"
- Check your internet connection
- Verify the proxy URL is correct
- Make sure the proxy server is running

### Low hashrate
- Close other CPU-intensive programs
- Make sure you're not thermal throttling
- Check XMRig output for errors

## Files

| File | Description |
|------|-------------|
| `miner.py` | Windows Python miner |
| `linux_miner.sh` | Linux Bash miner |
| `ws_bridge.py` | WebSocket-to-Stratum bridge |
| `setup.bat` | Windows dependency installer |
| `start_miner.bat` | Windows quick start |
| `setup_xmrig.sh` | Legacy XMRig setup |
| `start_xmrig.sh` | Legacy direct pool connection |
