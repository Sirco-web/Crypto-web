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

BRIDGE_VERSION = "3.2.0"

# Temperature thresholds (Celsius)
TEMP_THROTTLE = 80  # Start throttling at 80°C
TEMP_STOP = 90      # Stop mining at 90°C
TEMP_RESUME = 70    # Resume at 70°C

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
    
    # Windows: Try WMI
    if platform.system() == "Windows":
        try:
            result = subprocess.run(
                ['powershell', '-Command', 
                 'Get-WmiObject MSAcpi_ThermalZoneTemperature -Namespace "root/wmi" | Select-Object -ExpandProperty CurrentTemperature'],
                capture_output=True, text=True, timeout=5
            )
            if result.returncode == 0 and result.stdout.strip():
                # WMI returns temp in tenths of Kelvin
                temp_kelvin = float(result.stdout.strip().split('\n')[0]) / 10
                temp = temp_kelvin - 273.15
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
current_status = "mining"  # "mining", "temp-throttle", "temp-stop"
current_temp = None
is_throttled = False
is_temp_stopped = False

async def handle_stratum_client(reader, writer):
    """Handle incoming XMRig connection"""
    global client_id
    client_id += 1
    cid = client_id
    addr = writer.get_extra_info('peername')
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
    global current_job, ws_connection
    
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
        print(f"[Bridge] #{cid} Share submitted")
        
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

async def send_status_update():
    """Send temperature status to proxy server"""
    global ws_connection, current_status, current_temp
    
    if ws_connection:
        try:
            status_msg = {
                'type': 'status_update',
                'params': {
                    'status': current_status,
                    'temperature': current_temp,
                    'throttled': is_throttled,
                    'tempStopped': is_temp_stopped,
                    'version': BRIDGE_VERSION
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

async def websocket_handler():
    """Connect to proxy server via WebSocket"""
    global ws_connection, current_job
    
    while True:
        try:
            print(f"[Bridge] Connecting to {PROXY_WS_URL}...")
            async with websockets.connect(PROXY_WS_URL) as ws:
                ws_connection = ws
                print("[Bridge] Connected to proxy server!")
                
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
                            print(f"[Bridge] New job: {job.get('job_id', 'unknown')[:16]}...")
                            await broadcast_job_to_xmrig(job)
                            
                        elif msg_type == 'hash_accepted':
                            print("[Bridge] ✅ Share accepted by pool!")
                            
                        elif msg_type == 'error':
                            print(f"[Bridge] ❌ Error: {msg.get('params', {}).get('error')}")
                            
                    except json.JSONDecodeError:
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
