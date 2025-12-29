#!/usr/bin/env python3
"""
WebSocket-to-Stratum Bridge for Native Miners v4.1.0
SIMPLE THREADED VERSION - No async complexity.

Key improvements:
- XMRig connection NEVER drops (local stratum always available)
- WebSocket reconnects automatically in background
- Shares queued when WebSocket is down
- Uses threading instead of asyncio for simplicity

Usage:
  python ws_bridge.py
  
Then point XMRig to: stratum+tcp://127.0.0.1:3333
"""

import json
import sys
import os
import hashlib
import platform
import time
import subprocess
import socket
import threading
import select
import queue

try:
    import websocket
except ImportError:
    print("Installing websocket-client...")
    subprocess.run([sys.executable, "-m", "pip", "install", "websocket-client"], check=True)
    import websocket

BRIDGE_VERSION = "4.1.0"

# Temperature thresholds (Celsius)
TEMP_THROTTLE = 80
TEMP_STOP = 90
TEMP_RESUME = 70

# =============================================================================
# GLOBAL STATE
# =============================================================================
ws_connection = None           # WebSocket to proxy
ws_connected = False           # Is WebSocket connected?
ws_lock = threading.Lock()     # Thread-safe access
current_job = None             # Current mining job from pool
current_job_lock = threading.Lock()
xmrig_clients = {}             # {client_id: socket} - Connected XMRig instances
xmrig_lock = threading.Lock()
outgoing_queue = queue.Queue()  # Messages to send to proxy
pending_shares = []            # Shares waiting to be sent when WS reconnects
pending_lock = threading.Lock()
client_counter = 0

# Stats
current_hashrate = 0.0
current_temp = None
current_difficulty = 1000
share_times = []               # For hashrate estimation
share_times_lock = threading.Lock()
total_shares_submitted = 0
total_shares_accepted = 0

# Control flags
mining_paused = False
pool_suspended = False
running = True

# =============================================================================
# CLIENT ID
# =============================================================================
def get_or_create_client_id():
    id_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.bridge_client_id')
    if os.path.exists(id_file):
        with open(id_file, 'r') as f:
            return f.read().strip()
    try:
        import uuid
        machine_id = platform.node() + platform.machine() + str(uuid.getnode())
    except:
        machine_id = platform.node() + str(time.time())
    client_id = hashlib.md5((machine_id + str(time.time())).encode()).hexdigest()[:16]
    with open(id_file, 'w') as f:
        f.write(client_id)
    return client_id

BRIDGE_CLIENT_ID = get_or_create_client_id()
PROXY_WS_URL = f"wss://respectable-gilemette-timco-f0e524a9.koyeb.app/proxy?clientId={BRIDGE_CLIENT_ID}"
LOCAL_PORT = 3333

# =============================================================================
# TEMPERATURE
# =============================================================================
def get_cpu_temp():
    """Get CPU temperature (Windows)"""
    if platform.system() != "Windows":
        try:
            with open('/sys/class/thermal/thermal_zone0/temp', 'r') as f:
                return int(f.read().strip()) / 1000.0
        except:
            pass
        return None
    
    methods = [
        'Get-WmiObject MSAcpi_ThermalZoneTemperature -Namespace "root/wmi" 2>$null | Select-Object -ExpandProperty CurrentTemperature -First 1',
        'Get-WmiObject -Namespace "root/OpenHardwareMonitor" -Class Sensor 2>$null | Where-Object {$_.SensorType -eq "Temperature" -and $_.Name -match "CPU"} | Select-Object -ExpandProperty Value -First 1',
        'Get-WmiObject -Namespace "root/LibreHardwareMonitor" -Class Sensor 2>$null | Where-Object {$_.SensorType -eq "Temperature" -and $_.Name -match "CPU"} | Select-Object -ExpandProperty Value -First 1',
    ]
    
    for cmd in methods:
        try:
            result = subprocess.run(
                ['powershell', '-Command', cmd],
                capture_output=True, text=True, timeout=3
            )
            if result.returncode == 0 and result.stdout.strip():
                val = float(result.stdout.strip().split('\n')[0])
                if val > 1000:
                    val = val / 10 - 273.15
                if 0 < val < 120:
                    return val
        except:
            pass
    return None

# =============================================================================
# HASHRATE ESTIMATION
# =============================================================================
def update_hashrate():
    """Estimate hashrate from share submission rate"""
    global current_hashrate, share_times
    now = time.time()
    with share_times_lock:
        share_times = [t for t in share_times if now - t < 60]
        
        if len(share_times) >= 2:
            time_span = now - share_times[0]
            if time_span > 0:
                shares_per_sec = len(share_times) / time_span
                current_hashrate = shares_per_sec * current_difficulty
        elif len(share_times) == 1 and (now - share_times[0]) > 5:
            current_hashrate = current_difficulty / (now - share_times[0])
    
    return current_hashrate

def target_to_difficulty(target):
    """Convert stratum target to difficulty (little-endian)"""
    if not target or len(target) < 8:
        return 1000
    reversed_hex = ''.join(reversed([target[i:i+2] for i in range(0, 8, 2)]))
    target_value = int(reversed_hex, 16)
    if target_value == 0:
        return 1000000
    return int(0xFFFFFFFF / target_value)

# =============================================================================
# WEBSOCKET CALLBACKS
# =============================================================================
def on_ws_message(ws, message):
    """Handle message from proxy"""
    global current_job, current_difficulty, mining_paused, pool_suspended, total_shares_accepted
    
    try:
        msg = json.loads(message)
        msg_type = msg.get('type')
        
        if msg_type == 'authed':
            print("[WS] Authenticated")
            
        elif msg_type == 'job':
            job = msg.get('params', {})
            with current_job_lock:
                current_job = job
            target = job.get('target', '')
            if target:
                current_difficulty = target_to_difficulty(target)
            print(f"[WS] New job (diff: {current_difficulty})")
            broadcast_job(job)
            
        elif msg_type == 'hash_accepted':
            total_shares_accepted += 1
            print(f"[WS] ✓ Share accepted by pool!")
            
        elif msg_type == 'share_result':
            status = msg.get('status', '')
            if status == 'submitted':
                print(f"[WS] Share submitted")
            elif status == 'error':
                print(f"[WS] Share error: {msg.get('reason')}")
        
        elif msg_type == 'pong':
            pass  # Keepalive response
            
        elif msg_type == 'command':
            action = msg.get('action', '')
            if action in ('stop', 'pause'):
                mining_paused = True
                pool_suspended = (action == 'stop')
                print(f"[WS] ⏸ Mining paused: {msg.get('reason', '')}")
            elif action in ('start', 'resume'):
                mining_paused = False
                pool_suspended = False
                print(f"[WS] ▶ Mining resumed")
            elif action == 'kick':
                print(f"[WS] Kicked by server")
                os._exit(0)
                
    except json.JSONDecodeError:
        pass

def on_ws_error(ws, error):
    """Handle WebSocket error"""
    print(f"[WS] Error: {error}")

def on_ws_close(ws, close_status_code, close_msg):
    """Handle WebSocket close"""
    global ws_connected, ws_connection
    with ws_lock:
        ws_connected = False
        ws_connection = None
    print(f"[WS] Connection closed")

def on_ws_open(ws):
    """Handle WebSocket open"""
    global ws_connected, ws_connection
    with ws_lock:
        ws_connected = True
        ws_connection = ws
    print(f"[WS] ✓ Connected to proxy!")
    
    # Send auth
    ws.send(json.dumps({'type': 'auth', 'params': {}}))
    
    # Send any pending shares
    with pending_lock:
        while pending_shares:
            share = pending_shares.pop(0)
            try:
                ws.send(json.dumps(share))
                print(f"[WS] Sent queued share")
            except:
                pending_shares.insert(0, share)
                break

# =============================================================================
# WEBSOCKET MANAGER THREAD
# =============================================================================
def websocket_thread():
    """Background thread managing WebSocket connection"""
    global running
    
    while running:
        try:
            print(f"[WS] Connecting to proxy...")
            ws = websocket.WebSocketApp(
                PROXY_WS_URL,
                on_open=on_ws_open,
                on_message=on_ws_message,
                on_error=on_ws_error,
                on_close=on_ws_close
            )
            ws.run_forever(ping_interval=10, ping_timeout=20)
        except Exception as e:
            print(f"[WS] Error: {e}")
        
        if running:
            print(f"[WS] Reconnecting in 3 seconds...")
            time.sleep(3)

# =============================================================================
# SEND TO PROXY
# =============================================================================
def send_to_proxy(msg):
    """Send a message to proxy, queue if disconnected"""
    with ws_lock:
        if ws_connected and ws_connection:
            try:
                ws_connection.send(json.dumps(msg))
                return True
            except:
                pass
    
    # Queue for later
    if msg.get('type') == 'submit':
        with pending_lock:
            pending_shares.append(msg)
        print(f"[WS] Share queued (WS disconnected)")
    return False

# =============================================================================
# BROADCAST JOB TO XMRIG CLIENTS
# =============================================================================
def broadcast_job(job):
    """Send new job to all connected XMRig instances"""
    msg = json.dumps({
        'jsonrpc': '2.0',
        'method': 'job',
        'params': job
    }) + '\n'
    data = msg.encode()
    
    with xmrig_lock:
        dead_clients = []
        for cid, sock in xmrig_clients.items():
            try:
                sock.sendall(data)
            except:
                dead_clients.append(cid)
        for cid in dead_clients:
            del xmrig_clients[cid]

# =============================================================================
# XMRIG CLIENT HANDLER
# =============================================================================
def handle_xmrig_client(client_sock, client_addr, cid):
    """Handle a single XMRig connection"""
    global total_shares_submitted
    
    print(f"[Stratum] XMRig #{cid} connected from {client_addr}")
    
    with xmrig_lock:
        xmrig_clients[cid] = client_sock
    
    buffer = b''
    try:
        while running:
            try:
                readable, _, _ = select.select([client_sock], [], [], 1.0)
                if not readable:
                    continue
                
                data = client_sock.recv(4096)
                if not data:
                    break
                
                buffer += data
                while b'\n' in buffer:
                    line, buffer = buffer.split(b'\n', 1)
                    line = line.decode().strip()
                    if not line:
                        continue
                    
                    try:
                        msg = json.loads(line)
                        method = msg.get('method')
                        msg_id = msg.get('id')
                        
                        if method == 'login':
                            with current_job_lock:
                                job = current_job or {
                                    'job_id': 'waiting',
                                    'blob': '0' * 152,
                                    'target': '00000000',
                                    'seed_hash': '0' * 64,
                                    'height': 0,
                                    'algo': 'rx/0'
                                }
                            response = json.dumps({
                                'id': msg_id,
                                'jsonrpc': '2.0',
                                'result': {
                                    'id': f'xmrig-{cid}',
                                    'job': job,
                                    'status': 'OK'
                                },
                                'error': None
                            }) + '\n'
                            client_sock.sendall(response.encode())
                            print(f"[Stratum] #{cid} logged in")
                            
                        elif method == 'submit':
                            with share_times_lock:
                                share_times.append(time.time())
                            total_shares_submitted += 1
                            update_hashrate()
                            
                            ws_msg = {
                                'type': 'submit',
                                'params': msg.get('params', {})
                            }
                            send_to_proxy(ws_msg)
                            
                            response = json.dumps({
                                'id': msg_id,
                                'jsonrpc': '2.0',
                                'result': {'status': 'OK'},
                                'error': None
                            }) + '\n'
                            client_sock.sendall(response.encode())
                            
                        elif method == 'keepalived':
                            response = json.dumps({
                                'id': msg_id,
                                'jsonrpc': '2.0',
                                'result': {'status': 'KEEPALIVED'},
                                'error': None
                            }) + '\n'
                            client_sock.sendall(response.encode())
                            
                    except json.JSONDecodeError:
                        pass
                        
            except socket.timeout:
                continue
            except Exception as e:
                print(f"[Stratum] #{cid} error: {e}")
                break
                
    except Exception as e:
        print(f"[Stratum] #{cid} error: {e}")
    finally:
        with xmrig_lock:
            if cid in xmrig_clients:
                del xmrig_clients[cid]
        try:
            client_sock.close()
        except:
            pass
        print(f"[Stratum] #{cid} disconnected")

# =============================================================================
# STRATUM SERVER THREAD
# =============================================================================
def stratum_server_thread():
    """Local stratum server that XMRig connects to"""
    global client_counter, running
    
    server_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server_sock.bind(('127.0.0.1', LOCAL_PORT))
    server_sock.listen(5)
    server_sock.settimeout(1.0)
    
    print(f"[Stratum] Server listening on 127.0.0.1:{LOCAL_PORT}")
    
    while running:
        try:
            client_sock, client_addr = server_sock.accept()
            client_sock.settimeout(30)
            client_counter += 1
            cid = client_counter
            
            t = threading.Thread(target=handle_xmrig_client, args=(client_sock, client_addr, cid), daemon=True)
            t.start()
        except socket.timeout:
            continue
        except Exception as e:
            print(f"[Stratum] Accept error: {e}")
    
    server_sock.close()

# =============================================================================
# STATUS UPDATER THREAD
# =============================================================================
def status_updater_thread():
    """Send status updates to proxy every 10 seconds"""
    global current_temp, running
    
    while running:
        time.sleep(10)
        
        current_temp = get_cpu_temp()
        update_hashrate()
        
        if pool_suspended:
            status = "pool-suspended"
        elif mining_paused:
            status = "paused"
        elif current_temp and current_temp >= TEMP_STOP:
            status = "temp-stop"
        elif current_temp and current_temp >= TEMP_THROTTLE:
            status = "temp-throttle"
        else:
            status = "mining"
        
        with xmrig_lock:
            active_clients = len(xmrig_clients)
        with pending_lock:
            pending_count = len(pending_shares)
        
        send_to_proxy({
            'type': 'status_update',
            'params': {
                'status': status,
                'temperature': current_temp,
                'hashrate': current_hashrate,
                'activeClients': active_clients,
                'pendingShares': pending_count,
                'totalSubmitted': total_shares_submitted,
                'version': BRIDGE_VERSION
            }
        })

# =============================================================================
# KEEPALIVE PINGER THREAD
# =============================================================================
def keepalive_thread():
    """Send ping to proxy every 10 seconds"""
    global running
    
    while running:
        time.sleep(10)
        send_to_proxy({'type': 'ping'})

# =============================================================================
# MAIN
# =============================================================================
def main():
    global running
    
    print("=" * 60)
    print(f"  WebSocket-to-Stratum Bridge v{BRIDGE_VERSION}")
    print("=" * 60)
    print(f"  Client ID: {BRIDGE_CLIENT_ID}")
    print(f"  Proxy: {PROXY_WS_URL[:50]}...")
    print(f"  Local Stratum: stratum+tcp://127.0.0.1:{LOCAL_PORT}")
    print("=" * 60)
    print()
    print("  XMRig connects to local bridge - ALWAYS stays connected")
    print("  WebSocket to proxy reconnects automatically in background")
    print()
    
    threads = [
        threading.Thread(target=stratum_server_thread, daemon=True),
        threading.Thread(target=websocket_thread, daemon=True),
        threading.Thread(target=status_updater_thread, daemon=True),
        threading.Thread(target=keepalive_thread, daemon=True),
    ]
    
    for t in threads:
        t.start()
    
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[Bridge] Shutting down...")
        running = False
        time.sleep(1)

if __name__ == '__main__':
    print()
    print(f"[Bridge v{BRIDGE_VERSION}] Starting...")
    print()
    main()
