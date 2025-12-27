#!/usr/bin/env python3
"""
Native Python Miner - Connects to the same proxy as browser miners
Much faster than browser mining!

Install requirements:
    pip install websocket-client py-cryptonight

Run:
    python miner.py
"""

import json
import time
import struct
import hashlib
import threading
import multiprocessing
from binascii import hexlify, unhexlify

try:
    import websocket
except ImportError:
    print("❌ Missing websocket-client. Install with: pip install websocket-client")
    exit(1)

try:
    import pycryptonight
except ImportError:
    print("❌ Missing py-cryptonight. Install with: pip install py-cryptonight")
    print("   On Windows you may need: pip install py-cryptonight --only-binary :all:")
    exit(1)

# =============================================================================
# CONFIGURATION
# =============================================================================
PROXY_URL = "wss://respectable-gilemette-timco-f0e524a9.koyeb.app/proxy"
THREADS = max(1, multiprocessing.cpu_count() - 1)  # Leave 1 core free
HASHRATE_INTERVAL = 10  # Report hashrate every N seconds

# =============================================================================
# GLOBAL STATE
# =============================================================================
current_job = None
job_lock = threading.Lock()
running = True
total_hashes = 0
hash_count_lock = threading.Lock()
ws = None

# =============================================================================
# CRYPTONIGHT HASHING
# =============================================================================
def compute_hash(blob_hex, nonce):
    """Compute CryptoNight hash with given nonce"""
    blob = unhexlify(blob_hex)
    # Insert nonce at position 39 (bytes 39-42)
    blob = blob[:39] + struct.pack('<I', nonce) + blob[43:]
    # CryptoNight variant 0 (original)
    result = pycryptonight.cn_slow_hash(blob, 0)
    return hexlify(result).decode()

def check_hash(hash_hex, target_hex):
    """Check if hash meets target difficulty"""
    # Convert to integers (little endian)
    hash_val = int.from_bytes(unhexlify(hash_hex), 'little')
    target_val = int.from_bytes(unhexlify(target_hex.zfill(64)), 'little')
    return hash_val < target_val

def format_nonce(nonce):
    """Format nonce as hex string"""
    return hexlify(struct.pack('<I', nonce)).decode()

# =============================================================================
# MINING WORKER
# =============================================================================
def mining_worker(thread_id, start_nonce):
    """Mining thread - searches for valid shares"""
    global current_job, running, total_hashes, ws
    
    nonce = start_nonce
    local_hashes = 0
    
    print(f"  [Thread {thread_id}] Started, nonce range: {start_nonce:,}+")
    
    while running:
        with job_lock:
            job = current_job.copy() if current_job else None
        
        if not job:
            time.sleep(0.1)
            continue
        
        try:
            # Compute hash
            result = compute_hash(job['blob'], nonce)
            local_hashes += 1
            
            # Check if meets target
            if check_hash(result, job['target']):
                print(f"\n💎 [Thread {thread_id}] SHARE FOUND!")
                print(f"   Nonce: {format_nonce(nonce)}")
                print(f"   Hash:  {result[:32]}...")
                
                # Submit to proxy
                submit_msg = {
                    'type': 'submit',
                    'params': {
                        'job_id': job['job_id'],
                        'nonce': format_nonce(nonce),
                        'result': result
                    }
                }
                try:
                    ws.send(json.dumps(submit_msg))
                except:
                    print("   ⚠️ Failed to submit share")
            
            # Update global hash count periodically
            if local_hashes >= 100:
                with hash_count_lock:
                    total_hashes += local_hashes
                local_hashes = 0
            
            # Increment nonce (each thread has its own range)
            nonce += THREADS
            if nonce > 0xFFFFFFFF:
                nonce = thread_id  # Wrap around
                
        except Exception as e:
            print(f"  [Thread {thread_id}] Error: {e}")
            time.sleep(1)

# =============================================================================
# HASHRATE MONITOR
# =============================================================================
def hashrate_monitor():
    """Monitor and display hashrate"""
    global total_hashes, running
    
    last_hashes = 0
    last_time = time.time()
    
    while running:
        time.sleep(HASHRATE_INTERVAL)
        
        with hash_count_lock:
            current_hashes = total_hashes
        
        elapsed = time.time() - last_time
        hashes_done = current_hashes - last_hashes
        hashrate = hashes_done / elapsed if elapsed > 0 else 0
        
        print(f"⚡ Hashrate: {hashrate:.1f} H/s | Total: {current_hashes:,} hashes")
        
        # Send hashrate to proxy
        try:
            ws.send(json.dumps({
                'type': 'hashrate',
                'params': {'rate': hashrate}
            }))
        except:
            pass
        
        last_hashes = current_hashes
        last_time = time.time()

# =============================================================================
# WEBSOCKET HANDLERS
# =============================================================================
def on_message(ws_conn, message):
    """Handle messages from proxy"""
    global current_job
    
    try:
        msg = json.loads(message)
        
        if msg.get('type') == 'authed':
            print("✅ Authenticated with proxy!")
        
        elif msg.get('type') == 'job':
            params = msg['params']
            with job_lock:
                current_job = {
                    'job_id': params['job_id'],
                    'blob': params['blob'],
                    'target': params['target']
                }
            print(f"⛏️ New job received | Target: {params['target']}")
        
        elif msg.get('type') == 'hash_accepted':
            print("✅ Share ACCEPTED!")
        
        elif msg.get('type') == 'error':
            print(f"❌ Error: {msg['params'].get('error', 'Unknown')}")
        
        elif msg.get('type') == 'pong':
            pass  # Keep-alive response
            
    except Exception as e:
        print(f"Message error: {e}")

def on_error(ws_conn, error):
    print(f"❌ WebSocket error: {error}")

def on_close(ws_conn, close_status, close_msg):
    global running
    print(f"🔌 Disconnected from proxy")
    running = False

def on_open(ws_conn):
    global ws
    ws = ws_conn
    print("🔗 Connected to proxy!")
    
    # Authenticate
    auth_msg = {
        'type': 'auth',
        'params': {
            'site_key': 'native-miner',
            'type': 'anonymous',
            'user': None,
            'goal': 0
        }
    }
    ws.send(json.dumps(auth_msg))
    print("📤 Sent auth request...")

# =============================================================================
# MAIN
# =============================================================================
def main():
    global running, ws
    
    print("=" * 60)
    print("  💰 NATIVE PYTHON MINER")
    print("=" * 60)
    print(f"  Proxy:   {PROXY_URL}")
    print(f"  Threads: {THREADS}")
    print(f"  CPU:     {multiprocessing.cpu_count()} cores detected")
    print("=" * 60)
    print()
    
    # Start mining threads
    threads = []
    for i in range(THREADS):
        t = threading.Thread(target=mining_worker, args=(i, i), daemon=True)
        t.start()
        threads.append(t)
    
    # Start hashrate monitor
    monitor = threading.Thread(target=hashrate_monitor, daemon=True)
    monitor.start()
    
    # Connect to proxy
    print(f"🔗 Connecting to {PROXY_URL}...")
    
    while running:
        try:
            ws_app = websocket.WebSocketApp(
                PROXY_URL,
                on_open=on_open,
                on_message=on_message,
                on_error=on_error,
                on_close=on_close
            )
            ws_app.run_forever(ping_interval=20, ping_timeout=10)
        except KeyboardInterrupt:
            print("\n👋 Shutting down...")
            running = False
            break
        except Exception as e:
            print(f"Connection error: {e}")
            print("Reconnecting in 5 seconds...")
            time.sleep(5)

if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print("\n👋 Goodbye!")
