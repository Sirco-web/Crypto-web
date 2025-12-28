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
import websockets

# Configuration
PROXY_WS_URL = "wss://respectable-gilemette-timco-f0e524a9.koyeb.app/proxy"
LOCAL_PORT = 3333

# Store the current job
current_job = None
ws_connection = None
stratum_clients = {}
client_id = 0

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
    print("  WebSocket-to-Stratum Bridge for Native Miners")
    print("=" * 60)
    print(f"  Proxy: {PROXY_WS_URL}")
    print(f"  Local Stratum: stratum+tcp://127.0.0.1:{LOCAL_PORT}")
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
    
    async with stratum_server:
        await asyncio.gather(
            stratum_server.serve_forever(),
            ws_task
        )

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[Bridge] Shutting down...")
