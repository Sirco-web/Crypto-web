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
import threading
import multiprocessing
import platform
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
# VERSION INFO
# =============================================================================
CLIENT_VERSION = "2.5.0"
CLIENT_VERSION_DATE = "2025-12-27"

# =============================================================================
# CONFIGURATION
# =============================================================================
PROXY_URL = "wss://respectable-gilemette-timco-f0e524a9.koyeb.app/proxy"
CONTROL_URL = "wss://respectable-gilemette-timco-f0e524a9.koyeb.app/control"
THREADS = max(1, multiprocessing.cpu_count() - 1)  # Leave 1 core free
HASHRATE_INTERVAL = 10  # Report hashrate every N seconds
INFO_REPORT_INTERVAL = 5  # Report info to control socket every N seconds

# =============================================================================
# GLOBAL STATE
# =============================================================================
current_job = None
job_lock = threading.Lock()
running = True
mining_active = True  # Can be toggled via remote control
total_hashes = 0
hash_count_lock = threading.Lock()
ws = None
control_ws = None
current_hashrate = 0.0
status = "starting"

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
    global current_job, running, total_hashes, ws, mining_active
    
    nonce = start_nonce
    local_hashes = 0
    
    print(f"  [Thread {thread_id}] Started, nonce range: {start_nonce:,}+")
    
    while running:
        # Check if mining is paused by remote control
        if not mining_active:
            time.sleep(0.5)
            continue
            
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
    global total_hashes, running, current_hashrate, status
    
    last_hashes = 0
    last_time = time.time()
    
    while running:
        time.sleep(HASHRATE_INTERVAL)
        
        with hash_count_lock:
            current_hashes = total_hashes
        
        elapsed = time.time() - last_time
        hashes_done = current_hashes - last_hashes
        hashrate = hashes_done / elapsed if elapsed > 0 else 0
        current_hashrate = hashrate
        
        if mining_active:
            status = "mining"
            print(f"⚡ Hashrate: {hashrate:.1f} H/s | Total: {current_hashes:,} hashes")
        else:
            status = "stopped"
            print(f"⏸️ Mining paused | Total: {current_hashes:,} hashes")
        
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
    global ws, status
    ws = ws_conn
    status = "connected"
    print("🔗 Connected to proxy!")
    
    # Authenticate with version info
    auth_msg = {
        'type': 'auth',
        'params': {
            'site_key': 'native-miner',
            'type': 'anonymous',
            'user': None,
            'goal': 0,
            'clientVersion': CLIENT_VERSION
        }
    }
    ws.send(json.dumps(auth_msg))
    print("📤 Sent auth request...")

# =============================================================================
# CONTROL SOCKET HANDLERS
# =============================================================================
def on_control_message(ws_conn, message):
    """Handle messages from control socket"""
    global mining_active, THREADS, running
    
    try:
        msg = json.loads(message)
        
        if msg.get('type') == 'command':
            action = msg.get('action', '')
            reason = msg.get('reason', '')
            print(f"📡 Remote command: {action} {f'({reason})' if reason else ''}")
            
            if action == 'stop':
                mining_active = False
                print(f"⏸️ Mining stopped by remote command {f'- {reason}' if reason else ''}")
            
            elif action == 'start':
                mining_active = True
                print("▶️ Mining started by remote command")
            
            elif action == 'setThreads':
                new_threads = msg.get('value', THREADS)
                print(f"🔧 Thread count change requested: {new_threads} (restart required)")
            
            elif action == 'kick':
                print("👢 Kicked by owner, shutting down...")
                running = False
                ws_conn.close()
                
    except Exception as e:
        print(f"Control message error: {e}")

def on_control_error(ws_conn, error):
    print(f"⚠️ Control socket error: {error}")

def on_control_close(ws_conn, close_status, close_msg):
    print("🔌 Control socket disconnected, will reconnect...")

def on_control_open(ws_conn):
    global control_ws
    control_ws = ws_conn
    print("🎮 Connected to control channel!")
    
    # Send identification
    identify_msg = {
        'type': 'identify',
        'userAgent': f'Python/{platform.python_version()} ({platform.system()} {platform.machine()})',
        'clientVersion': CLIENT_VERSION,
        'clientVersionDate': CLIENT_VERSION_DATE
    }
    control_ws.send(json.dumps(identify_msg))
    
    # Start info reporting
    info_thread = threading.Thread(target=info_reporter, daemon=True)
    info_thread.start()

def info_reporter():
    """Report miner info to control socket periodically"""
    global control_ws, running, current_hashrate, status
    
    while running:
        time.sleep(INFO_REPORT_INTERVAL)
        
        if control_ws:
            try:
                info = {
                    'type': 'info',
                    'params': {
                        'cores': multiprocessing.cpu_count(),
                        'threads': THREADS,
                        'throttle': 0,
                        'status': status,
                        'hashrate': current_hashrate,
                        'clientVersion': CLIENT_VERSION
                    }
                }
                control_ws.send(json.dumps(info))
            except:
                pass

def control_socket_thread():
    """Run control socket in separate thread"""
    global running
    
    while running:
        try:
            ws_app = websocket.WebSocketApp(
                CONTROL_URL,
                on_open=on_control_open,
                on_message=on_control_message,
                on_error=on_control_error,
                on_close=on_control_close
            )
            ws_app.run_forever(ping_interval=30, ping_timeout=15)
        except Exception as e:
            print(f"Control socket error: {e}")
        
        if running:
            print("Control socket reconnecting in 10s...")
            time.sleep(10)

# =============================================================================
# MAIN
# =============================================================================
def main():
    global running, ws
    
    print("=" * 60)
    print(f"  💰 NATIVE PYTHON MINER v{CLIENT_VERSION}")
    print(f"  📅 {CLIENT_VERSION_DATE}")
    print("=" * 60)
    print(f"  Proxy:   {PROXY_URL}")
    print(f"  Control: {CONTROL_URL}")
    print(f"  Threads: {THREADS}")
    print(f"  CPU:     {multiprocessing.cpu_count()} cores detected")
    print(f"  Python:  {platform.python_version()}")
    print(f"  System:  {platform.system()} {platform.machine()}")
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
    
    # Start control socket in separate thread
    control_thread = threading.Thread(target=control_socket_thread, daemon=True)
    control_thread.start()
    
    # Connect to proxy (main thread)
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
