#!/usr/bin/env python3
"""
WebSocket-to-Stratum Bridge for Native Miners
Connects to the proxy server via WebSocket and exposes a local Stratum port
that XMRig can connect to.

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
import websockets
import signal

BRIDGE_VERSION = "3.6.0"

# Temperature thresholds (Celsius)
TEMP_THROTTLE = 80  # Start throttling at 80°C
TEMP_STOP = 90      # Stop mining at 90°C
TEMP_RESUME = 70    # Resume at 70°C

# Mining control flags
mining_paused = False  # True when server says to pause
mining_stopped_by_temp = False  # True when temp is too high

# Generate a unique client ID (persisted in a file)
def get_or_create_client_id():
    id_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.bridge_client_id')
    if os.path.exists(id_file):
        with open(id_file, 'r') as f:
            return f.read().strip()
    # Generate new ID based on machine + random
    try:
        import uuid
        machine_id = platform.node() + platform.machine() + str(uuid.getnode())
    except:
        machine_id = platform.node() + str(time.time())
    client_id = hashlib.md5((machine_id + str(time.time())).encode()).hexdigest()[:16]
    with open(id_file, 'w') as f:
        f.write(client_id)
    return client_id

def get_cpu_temp():
    """Get CPU temperature (cross-platform)"""
    temp = None
    
    # Windows: Try multiple methods
    if platform.system() == "Windows":
        # Method 1: WMI MSAcpi_ThermalZoneTemperature (requires admin on most systems)
        try:
            result = subprocess.run(
                ['powershell', '-Command', 
                 'Get-WmiObject MSAcpi_ThermalZoneTemperature -Namespace "root/wmi" 2>$null | Select-Object -ExpandProperty CurrentTemperature -First 1'],
                capture_output=True, text=True, timeout=5
            )
            if result.returncode == 0 and result.stdout.strip():
                # WMI returns temp in tenths of Kelvin
                temp_kelvin = float(result.stdout.strip().split('\n')[0]) / 10
                temp = temp_kelvin - 273.15
                if temp > 0 and temp < 120:  # Sanity check
                    return temp
        except:
            pass
        
        # Method 2: Try Open Hardware Monitor WMI (if installed)
        try:
            result = subprocess.run(
                ['powershell', '-Command', 
                 'Get-WmiObject -Namespace "root/OpenHardwareMonitor" -Class Sensor 2>$null | Where-Object {$_.SensorType -eq "Temperature" -and $_.Name -match "CPU"} | Select-Object -ExpandProperty Value -First 1'],
                capture_output=True, text=True, timeout=5
            )
            if result.returncode == 0 and result.stdout.strip():
                temp = float(result.stdout.strip())
                if temp > 0 and temp < 120:
                    return temp
        except:
            pass
        
        # Method 3: Try LibreHardwareMonitor WMI
        try:
            result = subprocess.run(
                ['powershell', '-Command', 
                 'Get-WmiObject -Namespace "root/LibreHardwareMonitor" -Class Sensor 2>$null | Where-Object {$_.SensorType -eq "Temperature" -and $_.Name -match "CPU"} | Select-Object -ExpandProperty Value -First 1'],
                capture_output=True, text=True, timeout=5
            )
            if result.returncode == 0 and result.stdout.strip():
                temp = float(result.stdout.strip())
                if temp > 0 and temp < 120:
                    return temp
        except:
            pass
    
    # Linux: Try multiple methods
    elif platform.system() == "Linux":
        # Method 1: thermal_zone
        try:
            with open('/sys/class/thermal/thermal_zone0/temp', 'r') as f:
                temp = int(f.read().strip()) / 1000.0
        except:
            pass
        
        # Method 2: hwmon
        if temp is None:
            try:
                import glob
                for hwmon in glob.glob('/sys/class/hwmon/hwmon*/temp1_input'):
                    try:
                        with open(hwmon, 'r') as f:
                            temp = int(f.read().strip()) / 1000.0
                            break
                    except:
                        pass
            except:
                pass
        
        # Method 3: Raspberry Pi (vcgencmd)
        if temp is None:
            try:
                result = subprocess.run(['vcgencmd', 'measure_temp'], capture_output=True, text=True, timeout=5)
                if result.returncode == 0:
                    # Output: "temp=42.8'C"
                    import re
                    match = re.search(r'temp=([0-9.]+)', result.stdout)
                    if match:
                        temp = float(match.group(1))
            except:
                pass
    
    return temp

BRIDGE_CLIENT_ID = get_or_create_client_id()

# Configuration
PROXY_WS_URL = f"wss://respectable-gilemette-timco-f0e524a9.koyeb.app/proxy?clientId={BRIDGE_CLIENT_ID}"
LOCAL_PORT = 3333

print(f"[Bridge v{BRIDGE_VERSION}] Client ID: {BRIDGE_CLIENT_ID}")
print(f"[Bridge] Proxy URL: {PROXY_WS_URL}")

# Store the current job
current_job = None
ws_connection = None
stratum_clients = {}
client_id = 0

# Temperature status tracking
current_status = "mining"  # "mining", "temp-throttle", "temp-stop", "pool-suspended"
current_temp = None
current_hashrate = 0.0  # Track hashrate from XMRig
current_difficulty = 1000  # Worker difficulty from job target
is_throttled = False
is_temp_stopped = False
pool_suspended = False
suspension_remaining = 0

# Hashrate estimation from share rate
share_times = []  # Timestamps of recent share submissions
HASHRATE_WINDOW = 60  # Calculate hashrate over last 60 seconds

def estimate_hashrate():
    """Estimate hashrate from share submission rate and difficulty"""
    global share_times, current_difficulty, current_hashrate
    
    now = time.time()
    # Remove old shares outside window
    share_times = [t for t in share_times if now - t < HASHRATE_WINDOW]
    
    if len(share_times) >= 2:
        # Hashrate = (shares * difficulty) / time_span
        time_span = now - share_times[0]
        if time_span > 0:
            # shares/second * difficulty = hashes/second
            shares_per_sec = len(share_times) / time_span
            current_hashrate = shares_per_sec * current_difficulty
    elif len(share_times) == 1:
        # Single share - estimate based on expected time
        # At diff D, expected time per share = D / hashrate
        # If we got a share, estimate hashrate = D / time_since_share
        time_since = now - share_times[0]
        if time_since > 1:
            current_hashrate = current_difficulty / time_since
    
    return current_hashrate

def target_to_difficulty(target):
    """Convert stratum target to difficulty (little-endian)"""
    if not target or len(target) < 8:
        return 1000
    # Reverse bytes for little-endian
    reversed_hex = ''.join(reversed([target[i:i+2] for i in range(0, 8, 2)]))
    target_value = int(reversed_hex, 16)
    if target_value == 0:
        return 1000000
    return int(0xFFFFFFFF / target_value)

async def handle_stratum_client(reader, writer):
    """Handle incoming XMRig connection"""
    global client_id, mining_paused, pool_suspended
    client_id += 1
    cid = client_id
    addr = writer.get_extra_info('peername')
    
    # Reject connections when mining is paused
    if mining_paused or pool_suspended:
        print(f"[Bridge] XMRig #{cid} rejected - mining is paused")
        writer.close()
        await writer.wait_closed()
        return
    
    print(f"[Bridge] XMRig #{cid} connected from {addr}")
    
    stratum_clients[cid] = {'reader': reader, 'writer': writer}
    
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
                await handle_stratum_message(cid, msg, writer)
            except json.JSONDecodeError as e:
                print(f"[Bridge] #{cid} Parse error: {e}")
                
    except Exception as e:
        print(f"[Bridge] #{cid} Error: {e}")
    finally:
        print(f"[Bridge] #{cid} Disconnected")
        del stratum_clients[cid]
        writer.close()

async def handle_stratum_message(cid, msg, writer):
    """Handle message from XMRig"""
    global current_job, ws_connection, share_times, current_hashrate
    
    method = msg.get('method')
    msg_id = msg.get('id')
    
    if method == 'login':
        print(f"[Bridge] #{cid} Login request")
        
        # Send auth response with current job
        response = {
            'id': msg_id,
            'jsonrpc': '2.0',
            'result': {
                'id': f'bridge-{cid}',
                'job': current_job,
                'status': 'OK'
            },
            'error': None
        }
        writer.write((json.dumps(response) + '\n').encode())
        await writer.drain()
        
    elif method == 'submit':
        # Record share time for hashrate estimation
        share_times.append(time.time())
        hr = estimate_hashrate()
        print(f"[Bridge] #{cid} Share submitted (est. {hr:.1f} H/s)")
        
        # Forward to WebSocket
        if ws_connection:
            ws_msg = {
                'type': 'submit',
                'params': msg.get('params', {})
            }
            await ws_connection.send(json.dumps(ws_msg))
        
        # Send OK immediately
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

async def broadcast_job_to_xmrig(job):
    """Send new job to all connected XMRig instances"""
    global current_job
    current_job = job
    
    msg = {
        'jsonrpc': '2.0',
        'method': 'job',
        'params': job
    }
    data = (json.dumps(msg) + '\n').encode()
    
    for cid, client in list(stratum_clients.items()):
        try:
            client['writer'].write(data)
            await client['writer'].drain()
        except:
            pass

async def handle_server_command(msg):
    """Handle commands from the proxy server"""
    global mining_paused, pool_suspended, stratum_clients
    
    action = msg.get('action', '')
    reason = msg.get('reason', '')
    threads = msg.get('threads')
    
    if action == 'stop':
        mining_paused = True
        pool_suspended = True
        print(f"[Bridge] ⛔ STOP COMMAND: {reason}")
        print("[Bridge] Mining paused - will resume when server sends start command")
        # Disconnect XMRig to stop mining
        await disconnect_all_xmrig()
        
    elif action == 'start':
        mining_paused = False
        pool_suspended = False
        print(f"[Bridge] ✅ START COMMAND: {reason}")
        print("[Bridge] Mining can resume - XMRig will reconnect")
        
    elif action == 'pause':
        mining_paused = True
        print(f"[Bridge] ⏸️ PAUSE COMMAND: {reason}")
        await disconnect_all_xmrig()
        
    elif action == 'resume':
        mining_paused = False
        print(f"[Bridge] ▶️ RESUME COMMAND: {reason}")
        
    elif action == 'kick':
        print(f"[Bridge] 👢 KICK COMMAND: Disconnecting...")
        await disconnect_all_xmrig()
        # Exit the bridge
        sys.exit(0)
        
    elif action == 'setThreads':
        if threads:
            print(f"[Bridge] 🔧 SET THREADS: {threads}")
            # XMRig doesn't support dynamic thread changes via stratum
            # User would need to restart with different config
            print("[Bridge] Note: Thread changes require XMRig restart")

async def disconnect_all_xmrig():
    """Disconnect all connected XMRig instances"""
    global stratum_clients
    for cid, client in list(stratum_clients.items()):
        try:
            client['writer'].close()
            await client['writer'].wait_closed()
        except:
            pass
    stratum_clients.clear()
    print("[Bridge] All XMRig instances disconnected")

async def send_status_update():
    """Send temperature and hashrate status to proxy server"""
    global ws_connection, current_status, current_temp, current_hashrate, mining_paused, pool_suspended
    
    if ws_connection:
        try:
            # Determine effective status
            if pool_suspended:
                effective_status = "pool-suspended"
            elif mining_paused:
                effective_status = "paused"
            elif is_temp_stopped:
                effective_status = "temp-stop"
            elif is_throttled:
                effective_status = "temp-throttle"
            else:
                effective_status = current_status
            
            status_msg = {
                'type': 'status_update',
                'params': {
                    'status': effective_status,
                    'temperature': current_temp,
                    'hashrate': current_hashrate if not mining_paused else 0.0,
                    'throttled': is_throttled,
                    'tempStopped': is_temp_stopped,
                    'poolSuspended': pool_suspended,
                    'paused': mining_paused,
                    'version': BRIDGE_VERSION,
                    'activeClients': len(stratum_clients)
                }
            }
            await ws_connection.send(json.dumps(status_msg))
        except:
            pass

async def temperature_monitor():
    """Monitor CPU temperature and update status"""
    global current_status, current_temp, is_throttled, is_temp_stopped
    
    while True:
        temp = get_cpu_temp()
        current_temp = temp
        
        if temp is not None:
            old_status = current_status
            
            if temp >= TEMP_STOP:
                current_status = "temp-stop"
                is_temp_stopped = True
                if old_status != current_status:
                    print(f"[Bridge] 🔥 TEMP CRITICAL: {temp:.0f}°C - Status: temp-stop")
                    
            elif temp >= TEMP_THROTTLE:
                current_status = "temp-throttle"
                is_throttled = True
                is_temp_stopped = False
                if old_status != current_status:
                    print(f"[Bridge] ⚠️  TEMP HIGH: {temp:.0f}°C - Status: temp-throttle")
                    
            elif temp < TEMP_RESUME:
                current_status = "mining"
                is_throttled = False
                is_temp_stopped = False
                if old_status != current_status:
                    print(f"[Bridge] ✓ TEMP OK: {temp:.0f}°C - Status: mining")
        
        # Send status update to proxy
        await send_status_update()
        
        await asyncio.sleep(10)

async def websocket_keepalive(ws):
    """Send periodic pings to keep the WebSocket connection alive"""
    while True:
        try:
            if ws.open:
                await ws.send(json.dumps({'type': 'ping'}))
            await asyncio.sleep(15)  # Ping every 15 seconds
        except:
            break

async def websocket_handler():
    """Connect to proxy server via WebSocket"""
    global ws_connection, current_job, pool_suspended
    
    while True:
        try:
            print(f"[Bridge] Connecting to {PROXY_WS_URL}...")
            # Use longer timeouts for cloud environments
            async with websockets.connect(
                PROXY_WS_URL,
                ping_interval=20,       # Send ping every 20 seconds
                ping_timeout=30,        # Wait 30 seconds for pong
                close_timeout=10,       # Wait 10 seconds for close
                max_size=10*1024*1024,  # 10MB max message size
            ) as ws:
                ws_connection = ws
                print("[Bridge] Connected to proxy server!")
                
                # Start keepalive task
                keepalive_task = asyncio.create_task(websocket_keepalive(ws))
                
                # Send auth
                await ws.send(json.dumps({'type': 'auth', 'params': {}}))
                
                async for message in ws:
                    try:
                        msg = json.loads(message)
                        msg_type = msg.get('type')
                        
                        if msg_type == 'authed':
                            print("[Bridge] Authenticated with proxy")
                            
                        elif msg_type == 'job':
                            job = msg.get('params', {})
                            # Extract difficulty from target
                            target = job.get('target', '')
                            if target:
                                global current_difficulty
                                current_difficulty = target_to_difficulty(target)
                            print(f"[Bridge] New job: {job.get('job_id', 'unknown')[:16]}... (diff: {current_difficulty})")
                            await broadcast_job_to_xmrig(job)
                            
                        elif msg_type == 'hash_accepted':
                            print("[Bridge] ✅ Share accepted by pool!")
                            
                        elif msg_type == 'share_result':
                            status = msg.get('status', '')
                            if status == 'submitted':
                                print("[Bridge] 📤 Share submitted to pool!")
                            elif status == 'error':
                                print(f"[Bridge] ⚠️ Share error: {msg.get('reason', 'unknown')}")
                        
                        elif msg_type == 'pong':
                            # Response to our ping - connection is alive
                            pass
                            
                        elif msg_type == 'command':
                            # Handle commands from proxy server
                            await handle_server_command(msg)
                            
                        elif msg_type == 'error':
                            error_msg = msg.get('params', {}).get('error', str(msg))
                            print(f"[Bridge] ❌ Error: {error_msg}")
                            # Check for suspension
                            if 'suspended' in str(error_msg).lower():
                                global pool_suspended, mining_paused
                                pool_suspended = True
                                mining_paused = True
                                print("[Bridge] ⛔ Pool IP suspended - mining paused...")
                            
                    except json.JSONDecodeError:
                        pass
                
                # Cancel keepalive when loop exits
                keepalive_task.cancel()
                        
        except asyncio.CancelledError:
            pass
        except Exception as e:
            print(f"[Bridge] WebSocket error: {e}")
            ws_connection = None
            
        print("[Bridge] Reconnecting in 5 seconds...")
        await asyncio.sleep(5)

async def main():
    print("=" * 60)
    print(f"  WebSocket-to-Stratum Bridge v{BRIDGE_VERSION}")
    print("=" * 60)
    print(f"  Proxy: {PROXY_WS_URL}")
    print(f"  Local Stratum: stratum+tcp://127.0.0.1:{LOCAL_PORT}")
    print(f"  Temperature Monitoring: Enabled")
    print(f"    - Throttle at: {TEMP_THROTTLE}°C")
    print(f"    - Stop at: {TEMP_STOP}°C")
    print(f"    - Resume at: {TEMP_RESUME}°C")
    print("=" * 60)
    print()
    print("Point your XMRig to: stratum+tcp://127.0.0.1:3333")
    print()
    
    # Start Stratum server
    stratum_server = await asyncio.start_server(
        handle_stratum_client,
        '127.0.0.1',
        LOCAL_PORT
    )
    print(f"[Bridge] Stratum server listening on 127.0.0.1:{LOCAL_PORT}")
    
    # Start WebSocket handler
    ws_task = asyncio.create_task(websocket_handler())
    
    # Start temperature monitor
    temp_task = asyncio.create_task(temperature_monitor())
    
    async with stratum_server:
        await asyncio.gather(
            stratum_server.serve_forever(),
            ws_task,
            temp_task
        )

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[Bridge] Shutting down...")
