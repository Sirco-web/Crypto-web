# Native XMR Miners

Native miners that connect through the proxy server. All miners (browser + native) are combined into ONE pool worker!

**Version 3.3.0** - Now with per-worker difficulty support!

## Available Miners

1. **Windows** - `miner.py` (Python + XMRig)
2. **Linux** - `linux_miner.sh` (Bash + XMRig)

Both miners use the `ws_bridge.py` WebSocket-to-Stratum bridge to connect through the proxy.

## Features

### ✅ Per-Worker Difficulty (NEW in v3.3.0)
Each worker gets their OWN difficulty based on their individual hashrate!
- Weak workers get easier targets → find shares faster
- Strong workers get harder targets → still find shares regularly
- All workers can contribute regardless of hashrate differences

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
