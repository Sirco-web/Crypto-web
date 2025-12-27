# Native Python Miner

A faster, native Python miner that connects to the same proxy as browser miners. All miners (browser + native) are combined into ONE pool worker!

## Requirements

- Python 3.7+
- Windows/Linux/Mac

## Setup (Windows)

1. Double-click `setup.bat` to install dependencies
2. Double-click `start_miner.bat` to start mining

## Setup (Linux/Mac)

```bash
pip install websocket-client py-cryptonight
python miner.py
```

## Why Native is Better

| Feature | Browser | Native Python |
|---------|---------|---------------|
| Hashrate | ~150 H/s | ~300-500 H/s |
| CPU Usage | Limited by browser | Full access |
| Background | Tab must stay open | Runs independently |
| Stability | May disconnect | More reliable |

## Configuration

Edit `miner.py` to change:

```python
PROXY_URL = "wss://your-proxy-url/proxy"  # Your proxy server
THREADS = 4  # Number of mining threads
```

## How It Works

1. Connects to your Koyeb proxy via WebSocket
2. Receives jobs (same as browser miners)
3. Computes CryptoNight hashes natively
4. Submits shares to proxy
5. Proxy combines ALL miners into one pool worker

Your hashrate will show up on the proxy dashboard alongside browser miners!
