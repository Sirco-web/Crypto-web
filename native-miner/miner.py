#!/usr/bin/env python3
# =============================================================================
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║                       XMR Native Miner for Windows                           ║
# ║                    Connects to Proxy Server (Combined Mining)                ║
# ╠══════════════════════════════════════════════════════════════════════════════╣
# ║  This miner connects through the proxy server so your hashrate is           ║
# ║  combined with all other miners. Controllable from the Owner Panel.         ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
# =============================================================================

import os
import sys
import json
import time
import socket
import threading
import subprocess
import zipfile
import urllib.request
import platform
import uuid
import hashlib

# =============================================================================
# CONFIGURATION - CONNECTS THROUGH PROXY
# =============================================================================
CLIENT_VERSION = "4.1.0"  # Threaded bridge for stability
WORKER_NAME = "windows-miner"

# Generate a unique client ID (persisted in a file)
def get_or_create_client_id():
    id_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.miner_client_id')
    if os.path.exists(id_file):
        with open(id_file, 'r') as f:
            return f.read().strip()
    # Generate new ID based on machine + random
    machine_id = platform.node() + platform.machine() + str(uuid.getnode())
    client_id = hashlib.md5((machine_id + str(time.time())).encode()).hexdigest()[:16]
    with open(id_file, 'w') as f:
        f.write(client_id)
    return client_id

MINER_CLIENT_ID = get_or_create_client_id()

# Proxy server settings
PROXY_HOST = "respectable-gilemette-timco-f0e524a9.koyeb.app"
PROXY_WS_URL = f"wss://{PROXY_HOST}/proxy?clientId={MINER_CLIENT_ID}"

# Local bridge for XMRig (run ws_bridge.py first, or use direct WebSocket mining)
LOCAL_STRATUM_HOST = "127.0.0.1"
LOCAL_STRATUM_PORT = 3333

# Temperature thresholds (Celsius)
TEMP_THROTTLE = 80  # Start throttling at 80°C
TEMP_STOP = 90      # Stop mining at 90°C
TEMP_RESUME = 70    # Resume at 70°C

# XMRig settings
XMRIG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "xmrig")
XMRIG_EXE = os.path.join(XMRIG_DIR, "xmrig.exe")
XMRIG_URL = "https://github.com/xmrig/xmrig/releases/download/v6.21.1/xmrig-6.21.1-msvc-win64.zip"

# Bridge script
BRIDGE_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ws_bridge.py")

# =============================================================================
# TERMINAL UI HELPERS
# =============================================================================
class Colors:
    RESET = "\033[0m"
    BOLD = "\033[1m"
    RED = "\033[91m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    BLUE = "\033[94m"
    CYAN = "\033[96m"
    WHITE = "\033[97m"
    # Cursor control
    SAVE_CURSOR = "\033[s"
    RESTORE_CURSOR = "\033[u"
    CLEAR_LINE = "\033[2K"
    MOVE_UP = "\033[1A"

# Status bar state
status_bar = {
    'hashrate': 0.0,
    'accepted': 0,
    'rejected': 0,
    'uptime': 0,
    'status': 'Starting...',
    'temp': None,
    'difficulty': 0,
    'pool_suspended': False
}
status_bar_enabled = True

def format_uptime(seconds):
    """Format uptime as H:MM:SS"""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    return f"{h}:{m:02d}:{s:02d}"

def print_status_bar():
    """Print the status bar at bottom of terminal"""
    if not status_bar_enabled:
        return
    
    hr = status_bar['hashrate']
    acc = status_bar['accepted']
    rej = status_bar['rejected']
    up = format_uptime(status_bar['uptime'])
    st = status_bar['status']
    temp = status_bar['temp']
    diff = status_bar['difficulty']
    suspended = status_bar['pool_suspended']
    
    # Build status line
    if suspended:
        line = f"{Colors.RED}⛔ POOL SUSPENDED - Waiting for reconnect...{Colors.RESET}"
    else:
        temp_str = f" | 🌡️ {temp:.0f}°C" if temp else ""
        diff_str = f" | Diff: {diff}" if diff > 0 else ""
        line = f"{Colors.CYAN}⛏️ {hr:.1f} H/s{Colors.RESET} | ✅ {acc} | ❌ {rej} | ⏱️ {up}{temp_str}{diff_str} | {st}"
    
    # Print at bottom (save cursor, move to bottom, clear, print, restore)
    print(f"\r{Colors.CLEAR_LINE}{line}", end='', flush=True)

def log_with_status(msg, color=Colors.WHITE, prefix="[i]"):
    """Log a message and redraw status bar"""
    # Clear current line, print message, then status bar
    print(f"\r{Colors.CLEAR_LINE}{Colors.WHITE}[{time.strftime('%H:%M:%S')}] {color}{prefix}{Colors.RESET} {msg}")
    print_status_bar()

def clear_screen():
    os.system('cls' if os.name == 'nt' else 'clear')

def print_banner():
    clear_screen()
    print(f"{Colors.CYAN}╔══════════════════════════════════════════════════════════════════════════════╗{Colors.RESET}")
    print(f"{Colors.CYAN}║{Colors.YELLOW}  ██╗  ██╗███╗   ███╗██████╗     ███╗   ███╗██╗███╗   ██╗███████╗██████╗      {Colors.CYAN}║{Colors.RESET}")
    print(f"{Colors.CYAN}║{Colors.YELLOW}  ╚██╗██╔╝████╗ ████║██╔══██╗    ████╗ ████║██║████╗  ██║██╔════╝██╔══██╗     {Colors.CYAN}║{Colors.RESET}")
    print(f"{Colors.CYAN}║{Colors.YELLOW}   ╚███╔╝ ██╔████╔██║██████╔╝    ██╔████╔██║██║██╔██╗ ██║█████╗  ██████╔╝     {Colors.CYAN}║{Colors.RESET}")
    print(f"{Colors.CYAN}║{Colors.YELLOW}   ██╔██╗ ██║╚██╔╝██║██╔══██╗    ██║╚██╔╝██║██║██║╚██╗██║██╔══╝  ██╔══██╗     {Colors.CYAN}║{Colors.RESET}")
    print(f"{Colors.CYAN}║{Colors.YELLOW}  ██╔╝ ██╗██║ ╚═╝ ██║██║  ██║    ██║ ╚═╝ ██║██║██║ ╚████║███████╗██║  ██║     {Colors.CYAN}║{Colors.RESET}")
    print(f"{Colors.CYAN}║{Colors.YELLOW}  ╚═╝  ╚═╝╚═╝     ╚═╝╚═╝  ╚═╝    ╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝     {Colors.CYAN}║{Colors.RESET}")
    print(f"{Colors.CYAN}╠══════════════════════════════════════════════════════════════════════════════╣{Colors.RESET}")
    print(f"{Colors.CYAN}║{Colors.WHITE}  Windows Native Miner v{CLIENT_VERSION} - Connects via Proxy (Combined Mining)     {Colors.CYAN}║{Colors.RESET}")
    print(f"{Colors.CYAN}║{Colors.GREEN}  Proxy: {PROXY_HOST}                                          {Colors.CYAN}║{Colors.RESET}")
    print(f"{Colors.CYAN}║{Colors.BLUE}  Client ID: {MINER_CLIENT_ID}                                       {Colors.CYAN}║{Colors.RESET}")
    print(f"{Colors.CYAN}╚══════════════════════════════════════════════════════════════════════════════╝{Colors.RESET}")
    print()

def log_info(msg):
    log_with_status(msg, Colors.BLUE, "[i]")

def log_success(msg):
    log_with_status(msg, Colors.GREEN, "[+]")

def log_warning(msg):
    log_with_status(msg, Colors.YELLOW, "[!]")

def log_error(msg):
    log_with_status(msg, Colors.RED, "[x]")

def log_hash(msg):
    log_with_status(msg, Colors.CYAN, "[#]")

# =============================================================================
# SYSTEM DETECTION
# =============================================================================
def get_cpu_info():
    """Get CPU information"""
    cores = os.cpu_count() or 4
    try:
        if platform.system() == "Windows":
            import subprocess
            result = subprocess.run(['wmic', 'cpu', 'get', 'name'], capture_output=True, text=True)
            name = result.stdout.strip().split('\n')[-1].strip()
        else:
            name = platform.processor() or "Unknown"
    except:
        name = platform.processor() or "Unknown CPU"
    return cores, name

def get_cpu_temp():
    """Get CPU temperature (Windows)"""
    try:
        # Try WMI (requires admin)
        import subprocess
        result = subprocess.run(
            ['powershell', '-Command', 
             'Get-WmiObject MSAcpi_ThermalZoneTemperature -Namespace "root/wmi" | Select-Object -ExpandProperty CurrentTemperature'],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0 and result.stdout.strip():
            # WMI returns temp in tenths of Kelvin
            temp_kelvin = float(result.stdout.strip().split('\n')[0]) / 10
            temp_celsius = temp_kelvin - 273.15
            return temp_celsius
    except:
        pass
    
    # Can't read temp
    return None

# =============================================================================
# CONNECTION CHECK
# =============================================================================
def check_connection():
    """Check if we can connect to the proxy server"""
    log_info("Checking connection to proxy server...")
    
    # First check internet connectivity
    try:
        socket.create_connection(("8.8.8.8", 53), timeout=5)
        log_success("Internet: Connected")
    except:
        log_error("Internet: No connection")
        return False
    
    # Check proxy server (HTTP port first)
    try:
        conn = socket.create_connection((PROXY_HOST, 443), timeout=10)
        conn.close()
        log_success(f"Proxy Server ({PROXY_HOST}): Reachable")
    except:
        log_warning(f"Proxy Server: Cannot verify HTTPS (this is normal)")
    
    # Note: Cloud deployments may not expose TCP port 3333
    # XMRig will fall back to stratum over TLS if available
    
    return True

# =============================================================================
# XMRIG MANAGEMENT
# =============================================================================
def download_xmrig():
    """Download XMRig if not present"""
    if os.path.exists(XMRIG_EXE):
        log_success("XMRig already installed")
        return True
    
    log_info("Downloading XMRig 6.21.1...")
    
    try:
        os.makedirs(XMRIG_DIR, exist_ok=True)
        zip_path = os.path.join(XMRIG_DIR, "xmrig.zip")
        
        # Download with progress
        def report_progress(block_num, block_size, total_size):
            downloaded = block_num * block_size
            if total_size > 0:
                percent = min(100, downloaded * 100 // total_size)
                print(f"\r{Colors.BLUE}[i]{Colors.RESET} Downloading: {percent}%", end='', flush=True)
        
        urllib.request.urlretrieve(XMRIG_URL, zip_path, report_progress)
        print()
        
        log_info("Extracting XMRig...")
        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            zip_ref.extractall(XMRIG_DIR)
        
        # Move files from subdirectory
        subdirs = [d for d in os.listdir(XMRIG_DIR) if os.path.isdir(os.path.join(XMRIG_DIR, d))]
        if subdirs:
            subdir = os.path.join(XMRIG_DIR, subdirs[0])
            for f in os.listdir(subdir):
                src = os.path.join(subdir, f)
                dst = os.path.join(XMRIG_DIR, f)
                if not os.path.exists(dst):
                    os.rename(src, dst)
        
        os.remove(zip_path)
        
        if os.path.exists(XMRIG_EXE):
            log_success("XMRig installed successfully!")
            return True
        else:
            log_error("XMRig executable not found after extraction")
            return False
            
    except Exception as e:
        log_error(f"Failed to download XMRig: {e}")
        return False

# =============================================================================
# MINER PROCESS
# =============================================================================
class MinerProcess:
    def __init__(self):
        self.process = None
        self.bridge_process = None
        self.running = False
        self.hashrate = 0
        self.accepted = 0
        self.rejected = 0
        self.throttled = False
        self.paused = False
        self.cores, self.cpu_name = get_cpu_info()
        self.threads = self.cores  # Full power
    
    def start_bridge(self):
        """Start the WebSocket-to-Stratum bridge"""
        if not os.path.exists(BRIDGE_SCRIPT):
            log_error("Bridge script not found: ws_bridge.py")
            return False
        
        log_info("Starting WebSocket bridge...")
        try:
            self.bridge_process = subprocess.Popen(
                [sys.executable, BRIDGE_SCRIPT],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1
            )
            
            # Start bridge output reader
            threading.Thread(target=self._read_bridge_output, daemon=True).start()
            
            # Wait for bridge to start
            time.sleep(3)
            log_success("WebSocket bridge started!")
            return True
            
        except Exception as e:
            log_error(f"Failed to start bridge: {e}")
            return False
    
    def _read_bridge_output(self):
        """Read and display bridge output"""
        try:
            for line in self.bridge_process.stdout:
                line = line.strip()
                if line:
                    if "error" in line.lower():
                        log_error(f"[Bridge] {line}")
                    elif "connected" in line.lower() or "authenticated" in line.lower():
                        log_success(f"[Bridge] {line}")
                    else:
                        log_info(f"[Bridge] {line}")
        except:
            pass
        
    def start(self):
        """Start XMRig connected to local bridge"""
        if self.running:
            return
        
        # First start the WebSocket bridge
        if not self.bridge_process:
            if not self.start_bridge():
                log_error("Cannot start without bridge")
                return False
        
        # Connect to local bridge
        pool_url = f"stratum+tcp://{LOCAL_STRATUM_HOST}:{LOCAL_STRATUM_PORT}"
        
        cmd = [
            XMRIG_EXE,
            "-o", pool_url,
            "-u", WORKER_NAME,
            "-p", "x",
            "-a", "rx/0",
            "-t", str(self.threads),
            "--no-color",
            "--print-time", "10"
        ]
        
        log_info(f"Starting XMRig with {self.threads} threads...")
        log_info(f"Connecting to local bridge: {pool_url}")
        
        try:
            self.process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1
            )
            self.running = True
            
            # Start output reader thread
            threading.Thread(target=self._read_output, daemon=True).start()
            
            log_success("XMRig started!")
            return True
            
        except Exception as e:
            log_error(f"Failed to start XMRig: {e}")
            self.running = False
            return False
    
    def _read_output(self):
        """Read and parse XMRig output"""
        try:
            for line in self.process.stdout:
                line = line.strip()
                if not line:
                    continue
                
                # Parse hashrate
                if "speed" in line.lower() and "h/s" in line.lower():
                    try:
                        # Format: "speed 10s/60s/15m 123.4 123.4 123.4 H/s"
                        parts = line.split()
                        for i, p in enumerate(parts):
                            if p.lower() == "h/s" and i > 0:
                                self.hashrate = float(parts[i-1])
                                log_hash(f"Hashrate: {self.hashrate:.1f} H/s")
                                break
                    except:
                        pass
                
                # Parse accepted shares
                elif "accepted" in line.lower():
                    self.accepted += 1
                    log_success(f"Share accepted! Total: {self.accepted}")
                
                # Parse rejected shares
                elif "rejected" in line.lower():
                    self.rejected += 1
                    log_warning(f"Share rejected. Total rejected: {self.rejected}")
                
                # Connection status
                elif "use pool" in line.lower() or "connected" in line.lower():
                    log_success("Connected to proxy server!")
                
                elif "connection" in line.lower() and ("error" in line.lower() or "failed" in line.lower()):
                    log_error(f"Connection issue: {line}")
                
                # Other important messages
                elif "error" in line.lower() or "warning" in line.lower():
                    log_warning(line)
                    
        except Exception as e:
            if self.running:
                log_error(f"Output reader error: {e}")
        finally:
            self.running = False
    
    def stop(self):
        """Stop XMRig and bridge"""
        if self.process:
            log_warning("Stopping XMRig...")
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except:
                self.process.kill()
            self.process = None
        
        if self.bridge_process:
            log_warning("Stopping bridge...")
            self.bridge_process.terminate()
            try:
                self.bridge_process.wait(timeout=3)
            except:
                self.bridge_process.kill()
            self.bridge_process = None
            
        self.running = False
        self.hashrate = 0
    
    def set_threads(self, threads):
        """Change thread count (requires restart)"""
        self.threads = max(1, min(threads, self.cores))
        if self.running:
            log_info(f"Restarting with {self.threads} threads...")
            # Only restart XMRig, not the bridge
            if self.process:
                self.process.terminate()
                try:
                    self.process.wait(timeout=5)
                except:
                    self.process.kill()
                self.process = None
            self.running = False
            time.sleep(1)
            self.start()

# =============================================================================
# TEMPERATURE MONITOR
# =============================================================================
class TempMonitor:
    def __init__(self, miner):
        self.miner = miner
        self.running = False
        
    def start(self):
        self.running = True
        threading.Thread(target=self._monitor_loop, daemon=True).start()
        
    def stop(self):
        self.running = False
        
    def _monitor_loop(self):
        while self.running:
            temp = get_cpu_temp()
            
            if temp is not None:
                if temp >= TEMP_STOP:
                    if not self.miner.paused:
                        log_error(f"🔥 CPU TEMP: {temp:.0f}°C - STOPPING MINER!")
                        self.miner.paused = True
                        self.miner.stop()
                        
                elif temp >= TEMP_THROTTLE:
                    if not self.miner.throttled:
                        log_warning(f"⚠️  CPU TEMP: {temp:.0f}°C - Throttling to 50%")
                        self.miner.throttled = True
                        self.miner.set_threads(max(1, self.miner.cores // 2))
                        
                elif temp < TEMP_RESUME:
                    if self.miner.paused:
                        log_success(f"✓ CPU TEMP: {temp:.0f}°C - Resuming mining")
                        self.miner.paused = False
                        self.miner.start()
                    elif self.miner.throttled:
                        log_success(f"✓ CPU TEMP: {temp:.0f}°C - Restoring full power")
                        self.miner.throttled = False
                        self.miner.set_threads(self.miner.cores)
            
            time.sleep(10)

# =============================================================================
# MAIN
# =============================================================================
def main():
    print_banner()
    
    # System info
    cores, cpu_name = get_cpu_info()
    log_info(f"CPU: {cpu_name}")
    log_info(f"Cores: {cores}")
    log_info(f"Platform: {platform.system()} {platform.release()}")
    print()
    
    # Check connection
    if not check_connection():
        log_error("Cannot connect to internet. Please check your connection.")
        input("\nPress Enter to exit...")
        sys.exit(1)
    print()
    
    # Download XMRig if needed
    if not download_xmrig():
        log_error("Cannot proceed without XMRig")
        input("\nPress Enter to exit...")
        sys.exit(1)
    print()
    
    # Check for websockets library
    try:
        import websockets
    except ImportError:
        log_warning("Installing websockets library...")
        subprocess.run([sys.executable, "-m", "pip", "install", "websockets"], check=True)
        log_success("websockets installed!")
    print()
    
    # Important note about proxy connection
    print(f"{Colors.YELLOW}{'='*78}{Colors.RESET}")
    print(f"{Colors.YELLOW}  ✓ This miner connects through the proxy server (WebSocket bridge){Colors.RESET}")
    print(f"{Colors.YELLOW}  ✓ Your hashrate will be COMBINED with all other miners{Colors.RESET}")
    print(f"{Colors.YELLOW}  ✓ You can be controlled from the Owner Panel{Colors.RESET}")
    print(f"{Colors.YELLOW}{'='*78}{Colors.RESET}")
    print()
    
    # Create miner
    miner = MinerProcess()
    
    # Start temp monitor
    temp_monitor = TempMonitor(miner)
    temp_monitor.start()
    
    # Start mining
    log_info("Starting miner (Full Power Mode)...")
    if not miner.start():
        log_error("Failed to start miner")
        input("\nPress Enter to exit...")
        sys.exit(1)
    
    print()
    log_success("Mining started! Press Ctrl+C to stop.")
    print()
    print()  # Extra line for status bar
    
    # Main loop - update status bar
    start_time = time.time()
    try:
        while True:
            time.sleep(1)
            
            # Update status bar data
            status_bar['uptime'] = time.time() - start_time
            status_bar['hashrate'] = miner.hashrate
            status_bar['accepted'] = miner.accepted
            status_bar['rejected'] = miner.rejected
            status_bar['temp'] = get_cpu_temp()
            
            if miner.paused:
                status_bar['status'] = f"{Colors.RED}PAUSED (temp){Colors.RESET}"
            elif miner.throttled:
                status_bar['status'] = f"{Colors.YELLOW}THROTTLED{Colors.RESET}"
            elif miner.running:
                status_bar['status'] = f"{Colors.GREEN}Mining{Colors.RESET}"
            else:
                status_bar['status'] = f"{Colors.YELLOW}Connecting...{Colors.RESET}"
            
            # Redraw status bar
            print_status_bar()
            
    except KeyboardInterrupt:
        print()
        print()
        log_warning("Stopping miner...")
        temp_monitor.stop()
        miner.stop()
        log_info("Goodbye!")

if __name__ == "__main__":
    main()
