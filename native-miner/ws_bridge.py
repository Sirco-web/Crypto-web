#!/usr/bin/env python3
"""
WebSocket-to-Stratum Bridge for Native Miners v4.0.0
COMPLETELY REWRITTEN for stability.

Key improvements:
- XMRig connection NEVER drops (local stratum always available)
- WebSocket reconnects automatically in background
- Shares queued when WebSocket is down
- Proper hashrate tracking

Usage:
  python ws_bridge.py
  
Then point XMRig to: stratum+tcp://127.0.0.1:3333
"""

import asyncio
import json
import sys
import os
import hashlib
import platform
import time
import subprocess

try:
    import websockets
except ImportError:
    print("Installing websockets...")
    subprocess.run([sys.executable, "-m", "pip", "install", "websockets"], check=True)
    import websockets

BRIDGE_VERSION = "4.0.0"

# Temperature thresholds (Celsius)
TEMP_THROTTLE = 80
TEMP_STOP = 90
TEMP_RESUME = 70

# =============================================================================
# GLOBAL STATE
# =============================================================================
ws_connection = None           # WebSocket to proxy
ws_connected = False           # Is WebSocket connected?
current_job = None             # Current mining job from pool
stratum_writers = {}           # {client_id: writer} - Connected XMRig instances
pending_shares = []            # Shares waiting to be sent when WS reconnects
client_counter = 0

# Stats
current_hashrate = 0.0
current_temp = None
current_difficulty = 1000
share_times = []               # For hashrate estimation
total_shares_submitted = 0
total_shares_accepted = 0

# Control flags
mining_paused = False
pool_suspended = False

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
        # Linux
        try:
            with open('/sys/class/thermal/thermal_zone0/temp', 'r') as f:
                return int(f.read().strip()) / 1000.0
        except:
            pass
        return None
    
    # Windows - try multiple methods
    methods = [
        # Method 1: WMI thermal zone
        'Get-WmiObject MSAcpi_ThermalZoneTemperature -Namespace "root/wmi" 2>$null | Select-Object -ExpandProperty CurrentTemperature -First 1',
        # Method 2: Open Hardware Monitor
        'Get-WmiObject -Namespace "root/OpenHardwareMonitor" -Class Sensor 2>$null | Where-Object {$_.SensorType -eq "Temperature" -and $_.Name -match "CPU"} | Select-Object -ExpandProperty Value -First 1',
        # Method 3: LibreHardwareMonitor
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
                # WMI returns tenths of Kelvin
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
    # Keep last 60 seconds of shares
    share_times = [t for t in share_times if now - t < 60]
    
    if len(share_times) >= 2:
        time_span = now - share_times[0]
        if time_span > 0:
            shares_per_sec = len(share_times) / time_span
            current_hashrate = shares_per_sec * current_difficulty
    elif len(share_times) == 1 and (now - share_times[0]) > 5:
        # Single share - rough estimate
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
# WEBSOCKET TO PROXY (runs in background, reconnects automatically)
# =============================================================================
async def websocket_manager():
    """Manages WebSocket connection to proxy - reconnects automatically"""
    global ws_connection, ws_connected, current_job, current_difficulty
    global mining_paused, pool_suspended, pending_shares, total_shares_accepted
    
    while True:
        try:
            print(f"[WS] Connecting to proxy...")
            async with websockets.connect(
                PROXY_WS_URL,
                ping_interval=15,
                ping_timeout=30,
                close_timeout=5,
            ) as ws:
                ws_connection = ws
                ws_connected = True
                print(f"[WS] ✓ Connected to proxy!")
                
                # Send auth
                await ws.send(json.dumps({'type': 'auth', 'params': {}}))
                
                # Send any pending shares
                while pending_shares:
                    share = pending_shares.pop(0)
                    try:
                        await ws.send(json.dumps(share))
                        print(f"[WS] Sent queued share")
                    except:
                        pending_shares.insert(0, share)
                        break
                
                # Listen for messages
                async for message in ws:
                    try:
                        msg = json.loads(message)
                        msg_type = msg.get('type')
                        
                        if msg_type == 'authed':
                            print("[WS] Authenticated")
                            
                        elif msg_type == 'job':
                            job = msg.get('params', {})
                            current_job = job
                            target = job.get('target', '')
                            if target:
                                current_difficulty = target_to_difficulty(target)
                            print(f"[WS] New job (diff: {current_difficulty})")
                            # Broadcast to all XMRig instances
                            await broadcast_job(job)
                            
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
                                sys.exit(0)
                                
                    except json.JSONDecodeError:
                        pass
                        
        except asyncio.CancelledError:
            break
        except Exception as e:
            ws_connected = False
            ws_connection = None
            print(f"[WS] Disconnected: {e}")
        
        ws_connected = False
        ws_connection = None
        print(f"[WS] Reconnecting in 3 seconds...")
        await asyncio.sleep(3)

async def send_to_proxy(msg):
    """Send a message to proxy, queue if disconnected"""
    global pending_shares
    if ws_connected and ws_connection:
        try:
            await ws_connection.send(json.dumps(msg))
            return True
        except:
            pass
    # Queue for later
    if msg.get('type') == 'submit':
        pending_shares.append(msg)
        print(f"[WS] Share queued (WS disconnected)")
    return False

# =============================================================================
# LOCAL STRATUM SERVER (always running, never disconnects)
# =============================================================================
async def handle_xmrig(reader, writer):
    """Handle XMRig connection - stays connected regardless of WebSocket status"""
    global client_counter, share_times, total_shares_submitted
    
    client_counter += 1
    cid = client_counter
    addr = writer.get_extra_info('peername')
    print(f"[Stratum] XMRig #{cid} connected from {addr}")
    
    stratum_writers[cid] = writer
    
    try:
        while True:
            data = await reader.readline()
            if not data:
                break
            
            line = data.decode().strip()
            if not line:
                continue
            
            try:
                msg = json.loads(line)
                method = msg.get('method')
                msg_id = msg.get('id')
                
                if method == 'login':
                    # Send job (or placeholder if no job yet)
                    job = current_job or {
                        'job_id': 'waiting',
                        'blob': '0' * 152,
                        'target': '00000000',
                        'seed_hash': '0' * 64,
                        'height': 0,
                        'algo': 'rx/0'
                    }
                    response = {
                        'id': msg_id,
                        'jsonrpc': '2.0',
                        'result': {
                            'id': f'xmrig-{cid}',
                            'job': job,
                            'status': 'OK'
                        },
                        'error': None
                    }
                    writer.write((json.dumps(response) + '\n').encode())
                    await writer.drain()
                    print(f"[Stratum] #{cid} logged in")
                    
                elif method == 'submit':
                    # Record share for hashrate
                    share_times.append(time.time())
                    total_shares_submitted += 1
                    update_hashrate()
                    
                    # Forward to proxy
                    ws_msg = {
                        'type': 'submit',
                        'params': msg.get('params', {})
                    }
                    await send_to_proxy(ws_msg)
                    
                    # Always tell XMRig it's OK (proxy will validate)
                    response = {
                        'id': msg_id,
                        'jsonrpc': '2.0',
                        'result': {'status': 'OK'},
                        'error': None
                    }
                    writer.write((json.dumps(response) + '\n').encode())
                    await writer.drain()
                    
                elif method == 'keepalived':
                    response = {
                        'id': msg_id,
                        'jsonrpc': '2.0',
                        'result': {'status': 'KEEPALIVED'},
                        'error': None
                    }
                    writer.write((json.dumps(response) + '\n').encode())
                    await writer.drain()
                    
            except json.JSONDecodeError:
                pass
                
    except Exception as e:
        print(f"[Stratum] #{cid} error: {e}")
    finally:
        del stratum_writers[cid]
        writer.close()
        print(f"[Stratum] #{cid} disconnected")

async def broadcast_job(job):
    """Send new job to all connected XMRig instances"""
    msg = {
        'jsonrpc': '2.0',
        'method': 'job',
        'params': job
    }
    data = (json.dumps(msg) + '\n').encode()
    
    for cid, writer in list(stratum_writers.items()):
        try:
            writer.write(data)
            await writer.drain()
        except:
            pass

# =============================================================================
# STATUS UPDATER (sends temp/hashrate to proxy periodically)
# =============================================================================
async def status_updater():
    """Send status updates to proxy every 10 seconds"""
    global current_temp
    
    while True:
        await asyncio.sleep(10)
        
        # Update temp
        current_temp = get_cpu_temp()
        update_hashrate()
        
        # Determine status
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
        
        # Send to proxy
        if ws_connected and ws_connection:
            try:
                await ws_connection.send(json.dumps({
                    'type': 'status_update',
                    'params': {
                        'status': status,
                        'temperature': current_temp,
                        'hashrate': current_hashrate,
                        'activeClients': len(stratum_writers),
                        'pendingShares': len(pending_shares),
                        'totalSubmitted': total_shares_submitted,
                        'version': BRIDGE_VERSION
                    }
                }))
            except:
                pass

# =============================================================================
# KEEPALIVE PINGER
# =============================================================================
async def keepalive_pinger():
    """Send ping to proxy every 10 seconds to keep connection alive"""
    while True:
        await asyncio.sleep(10)
        if ws_connected and ws_connection:
            try:
                await ws_connection.send(json.dumps({'type': 'ping'}))
            except:
                pass

# =============================================================================
# MAIN
# =============================================================================
async def main():
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
    
    # Start local stratum server (always running)
    stratum_server = await asyncio.start_server(
        handle_xmrig,
        '127.0.0.1',
        LOCAL_PORT
    )
    print(f"[Stratum] Server listening on 127.0.0.1:{LOCAL_PORT}")
    
    # Start background tasks
    tasks = [
        asyncio.create_task(websocket_manager()),
        asyncio.create_task(status_updater()),
        asyncio.create_task(keepalive_pinger()),
    ]
    
    async with stratum_server:
        try:
            await asyncio.gather(stratum_server.serve_forever(), *tasks)
        except asyncio.CancelledError:
            pass

if __name__ == '__main__':
    print()
    print(f"[Bridge v{BRIDGE_VERSION}] Starting...")
    print()
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[Bridge] Shutting down...")
