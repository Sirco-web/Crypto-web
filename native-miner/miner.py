#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════════════════════════╗
║                    🔥 WINDOWS RANDOMX MINER (XMRig)                          ║
║                         MoneroOcean Pool Miner                               ║
╚══════════════════════════════════════════════════════════════════════════════╝

Native Windows miner using XMRig for maximum RandomX performance.
Connects directly to MoneroOcean pool.

Features:
- CPU temperature monitoring (auto throttle if too hot)
- Connection quality check before mining
- Nice terminal UI with live stats
- Auto XMRig download and setup
- Full power by default
"""

import os
import sys
import time
import json
import socket
import subprocess
import platform
import threading
import urllib.request
import urllib.error
import zipfile
import shutil
from datetime import datetime

# =============================================================================
# VERSION INFO
# =============================================================================
CLIENT_VERSION = "3.0.0"
CLIENT_VERSION_DATE = "2025-12-27"
CLIENT_TYPE = "windows-python"

# =============================================================================
# CONFIGURATION
# =============================================================================
# Pool settings (direct to MoneroOcean)
POOL_URL = "gulf.moneroocean.stream:10128"
WALLET = "42C9fVZdev5ZW7k6NmNGECVEpy2sCkA8JMpA1i2zLxUwCociGC3VzAbJ5WoMUFp3qeSqpCuueTvKgXZh8cnkbj957aBZiAB"
WORKER_NAME = "windows-miner"
PASS = "x"
ALGO = "rx/0"

# Proxy settings (for reporting stats)
PROXY_HOST = "respectable-gilemette-timco-f0e524a9.koyeb.app"
PROXY_PORT = 443

# Temperature thresholds (Celsius)
TEMP_THROTTLE = 80  # Start throttling at 80°C
TEMP_STOP = 90      # Stop mining at 90°C
TEMP_RESUME = 70    # Resume at 70°C

# XMRig settings
XMRIG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "xmrig")
XMRIG_EXE = os.path.join(XMRIG_DIR, "xmrig.exe")
XMRIG_URL = "https://github.com/xmrig/xmrig/releases/download/v6.21.1/xmrig-6.21.1-msvc-win64.zip"

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

def clear_screen():
    os.system('cls' if os.name == 'nt' else 'clear')

def print_banner():
    banner = f"""
{Colors.CYAN}╔══════════════════════════════════════════════════════════════════════════════╗
║{Colors.YELLOW}  ██╗  ██╗███╗   ███╗██████╗     ███╗   ███╗██╗███╗   ██╗███████╗██████╗      {Colors.CYAN}║
║{Colors.YELLOW}  ╚██╗██╔╝████╗ ████║██╔══██╗    ████╗ ████║██║████╗  ██║██╔════╝██╔══██╗     {Colors.CYAN}║
║{Colors.YELLOW}   ╚███╔╝ ██╔████╔██║██████╔╝    ██╔████╔██║██║██╔██╗ ██║█████╗  ██████╔╝     {Colors.CYAN}║
║{Colors.YELLOW}   ██╔██╗ ██║╚██╔╝██║██╔══██╗    ██║╚██╔╝██║██║██║╚██╗██║██╔══╝  ██╔══██╗     {Colors.CYAN}║
║{Colors.YELLOW}  ██╔╝ ██╗██║ ╚═╝ ██║██║  ██║    ██║ ╚═╝ ██║██║██║ ╚████║███████╗██║  ██║     {Colors.CYAN}║
║{Colors.YELLOW}  ╚═╝  ╚═╝╚═╝     ╚═╝╚═╝  ╚═╝    ╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝     {Colors.CYAN}║
╠══════════════════════════════════════════════════════════════════════════════╣
║{Colors.WHITE}  RandomX Windows Miner v{CLIENT_VERSION} (Full Power Mode)                           {Colors.CYAN}║
║{Colors.GREEN}  Pool: MoneroOcean                                                            {Colors.CYAN}║
╚══════════════════════════════════════════════════════════════════════════════╝{Colors.RESET}
"""
    print(banner)

def print_status(message, status="info"):
    icons = {
        "info": f"{Colors.BLUE}[i]",
        "success": f"{Colors.GREEN}[+]",
        "warning": f"{Colors.YELLOW}[!]",
        "error": f"{Colors.RED}[x]",
        "mining": f"{Colors.GREEN}[*]",
    }
    icon = icons.get(status, icons["info"])
    timestamp = datetime.now().strftime("%H:%M:%S")
    print(f"{Colors.WHITE}[{timestamp}] {icon} {message}{Colors.RESET}")

# =============================================================================
# CONNECTION CHECK
# =============================================================================
def check_connection():
    """Check connection quality before mining"""
    print_status("Checking connection quality...", "info")
    
    # Check 1: Internet connectivity
    try:
        socket.create_connection(("8.8.8.8", 53), timeout=5)
        print_status("Internet: Connected", "success")
    except OSError:
        print_status("Internet: No connection!", "error")
        return False
    
    # Check 2: Pool connectivity
    try:
        host, port = POOL_URL.split(":")
        socket.create_connection((host, int(port)), timeout=10)
        print_status(f"Pool ({host}): Reachable", "success")
    except Exception as e:
        print_status(f"Pool: Unreachable - {e}", "error")
        return False
    
    # Check 3: Latency test
    try:
        host, port = POOL_URL.split(":")
        start = time.time()
        s = socket.create_connection((host, int(port)), timeout=10)
        s.close()
        latency = (time.time() - start) * 1000
        if latency < 100:
            print_status(f"Latency: {latency:.0f}ms (Excellent)", "success")
        elif latency < 250:
            print_status(f"Latency: {latency:.0f}ms (Good)", "success")
        elif latency < 500:
            print_status(f"Latency: {latency:.0f}ms (Fair)", "warning")
        else:
            print_status(f"Latency: {latency:.0f}ms (Poor - may cause stale shares)", "warning")
    except:
        pass
    
    print_status("Connection check passed!", "success")
    return True

# =============================================================================
# CPU TEMPERATURE MONITORING (Windows)
# =============================================================================
def get_cpu_temp():
    """Get CPU temperature on Windows"""
    # Try WMI
    try:
        import wmi
        w = wmi.WMI(namespace="root\\wmi")
        temp_info = w.MSAcpi_ThermalZoneTemperature()[0]
        temp_kelvin = temp_info.CurrentTemperature
        temp_celsius = (temp_kelvin / 10.0) - 273.15
        return temp_celsius
    except:
        pass
    
    # Try OpenHardwareMonitor
    try:
        import wmi
        w = wmi.WMI(namespace="root\\OpenHardwareMonitor")
        sensors = w.Sensor()
        for sensor in sensors:
            if sensor.SensorType == 'Temperature' and 'CPU' in sensor.Name:
                return float(sensor.Value)
    except:
        pass
    
    return None

class TempMonitor(threading.Thread):
    """Background thread to monitor CPU temperature"""
    
    def __init__(self, miner):
        super().__init__(daemon=True)
        self.miner = miner
        self.running = True
        self.current_temp = None
        self.throttled = False
        self.stopped_for_temp = False
    
    def run(self):
        while self.running:
            temp = get_cpu_temp()
            if temp is not None:
                self.current_temp = temp
                
                if temp >= TEMP_STOP and not self.stopped_for_temp:
                    print_status(f"CPU TEMP CRITICAL: {temp:.1f}°C - STOPPING!", "error")
                    self.stopped_for_temp = True
                    self.miner.pause_for_temp()
                elif temp >= TEMP_THROTTLE and not self.throttled and not self.stopped_for_temp:
                    print_status(f"CPU TEMP HIGH: {temp:.1f}°C - Throttling...", "warning")
                    self.throttled = True
                elif temp <= TEMP_RESUME and self.stopped_for_temp:
                    print_status(f"CPU TEMP OK: {temp:.1f}°C - Resuming...", "success")
                    self.stopped_for_temp = False
                    self.throttled = False
                    self.miner.resume_from_temp()
                elif temp < TEMP_THROTTLE - 5 and self.throttled:
                    self.throttled = False
            
            time.sleep(5)
    
    def stop(self):
        self.running = False

# =============================================================================
# XMRIG INSTALLATION
# =============================================================================
def download_xmrig():
    """Download and extract XMRig for Windows"""
    print_status("XMRig not found. Downloading...", "info")
    
    zip_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "xmrig.zip")
    
    try:
        print_status(f"Downloading XMRig...", "info")
        urllib.request.urlretrieve(XMRIG_URL, zip_path)
        print_status("Download complete!", "success")
        
        print_status("Extracting...", "info")
        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            root_folder = zip_ref.namelist()[0].split('/')[0]
            zip_ref.extractall(os.path.dirname(os.path.abspath(__file__)))
        
        extracted_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), root_folder)
        if os.path.exists(XMRIG_DIR):
            shutil.rmtree(XMRIG_DIR)
        os.rename(extracted_dir, XMRIG_DIR)
        
        os.remove(zip_path)
        
        print_status("XMRig installed successfully!", "success")
        return True
        
    except Exception as e:
        print_status(f"Failed to download XMRig: {e}", "error")
        return False

def check_xmrig():
    """Check if XMRig is installed"""
    if os.path.exists(XMRIG_EXE):
        return True
    return download_xmrig()

# =============================================================================
# MINING
# =============================================================================
class XMRigMiner:
    def __init__(self):
        self.process = None
        self.shares_accepted = 0
        self.shares_rejected = 0
        self.running = False
        self.paused = False
        self.temp_monitor = None
    
    def pause_for_temp(self):
        """Temporarily stop due to temperature"""
        if self.process and self.running:
            self.paused = True
            self.process.terminate()
            self.process.wait(timeout=5)
            self.process = None
            print_status("Mining paused due to temperature", "warning")
    
    def resume_from_temp(self):
        """Resume after temperature dropped"""
        if self.paused and not self.running:
            print_status("Resuming mining...", "info")
            self.paused = False
            self._start_xmrig()
    
    def _start_xmrig(self):
        """Internal method to start XMRig process"""
        cmd = [
            XMRIG_EXE,
            "-o", POOL_URL,
            "-u", WALLET,
            "-p", WORKER_NAME,
            "-a", ALGO,
            "-k",
            "--donate-level=1",
            "--print-time=5"
        ]
        
        self.process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            universal_newlines=True,
            bufsize=1
        )
        self.running = True
    
    def start(self):
        """Start XMRig"""
        if not check_xmrig():
            print_status("Cannot start - XMRig not available", "error")
            return False
        
        print_status("Starting XMRig miner at FULL POWER...", "mining")
        print_status(f"Using all {os.cpu_count()} CPU cores", "info")
        
        try:
            self._start_xmrig()
            
            # Start temp monitor
            self.temp_monitor = TempMonitor(self)
            self.temp_monitor.start()
            
            # Read output
            self.read_output()
            
        except Exception as e:
            print_status(f"Failed to start XMRig: {e}", "error")
            return False
        
        return True
    
    def read_output(self):
        """Read and display XMRig output with colors"""
        try:
            while self.running or self.paused:
                if self.process and self.process.stdout:
                    line = self.process.stdout.readline()
                    if not line:
                        if self.paused:
                            time.sleep(1)
                            continue
                        break
                    
                    line = line.strip()
                    if not line:
                        continue
                    
                    # Colorize output
                    if "accepted" in line.lower():
                        print(f"{Colors.GREEN}{line}{Colors.RESET}")
                        self.shares_accepted += 1
                    elif "rejected" in line.lower():
                        print(f"{Colors.RED}{line}{Colors.RESET}")
                        self.shares_rejected += 1
                    elif "speed" in line.lower() or "h/s" in line.lower():
                        print(f"{Colors.CYAN}{line}{Colors.RESET}")
                    elif "error" in line.lower():
                        print(f"{Colors.RED}{line}{Colors.RESET}")
                    elif "new job" in line.lower():
                        print(f"{Colors.YELLOW}{line}{Colors.RESET}")
                    elif "block" in line.lower():
                        print(f"{Colors.GREEN}{Colors.BOLD}*** {line} ***{Colors.RESET}")
                    else:
                        print(line)
                else:
                    time.sleep(0.5)
                    
        except KeyboardInterrupt:
            self.stop()
    
    def stop(self):
        """Stop XMRig"""
        print_status("Stopping miner...", "warning")
        self.running = False
        self.paused = False
        
        if self.temp_monitor:
            self.temp_monitor.stop()
        
        if self.process:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except:
                self.process.kill()
            self.process = None
        
        print_status("Miner stopped.", "info")

# =============================================================================
# MAIN
# =============================================================================
def main():
    # Enable ANSI colors on Windows
    if os.name == 'nt':
        os.system('')
    
    clear_screen()
    print_banner()
    
    print_status(f"Version: {CLIENT_VERSION} ({CLIENT_VERSION_DATE})", "info")
    print_status(f"Platform: Windows x64", "info")
    print_status(f"CPU Cores: {os.cpu_count()}", "info")
    print()
    
    # Connection check
    if not check_connection():
        print_status("Connection check failed!", "error")
        print_status("Please check your internet connection and try again.", "error")
        input("\nPress Enter to exit...")
        sys.exit(1)
    
    print()
    print_status(f"Wallet: {WALLET[:12]}...{WALLET[-8:]}", "info")
    print_status(f"Pool: {POOL_URL}", "info")
    print_status(f"Algorithm: {ALGO} (RandomX)", "info")
    print_status(f"Mode: FULL POWER (all cores)", "mining")
    print()
    
    # Temperature check
    temp = get_cpu_temp()
    if temp:
        print_status(f"CPU Temperature: {temp:.1f}°C", "info")
    else:
        print_status("CPU Temperature: Not available (install WMI for monitoring)", "warning")
    
    print()
    print(f"{Colors.YELLOW}{'='*78}{Colors.RESET}")
    print(f"{Colors.YELLOW}  Press Ctrl+C to stop mining{Colors.RESET}")
    print(f"{Colors.YELLOW}{'='*78}{Colors.RESET}")
    print()
    
    # Start mining
    miner = XMRigMiner()
    
    try:
        miner.start()
    except KeyboardInterrupt:
        pass
    finally:
        miner.stop()
    
    print()
    print(f"{Colors.CYAN}{'='*78}{Colors.RESET}")
    print(f"{Colors.WHITE}  Session Statistics:{Colors.RESET}")
    print(f"{Colors.GREEN}    Accepted Shares: {miner.shares_accepted}{Colors.RESET}")
    print(f"{Colors.RED}    Rejected Shares: {miner.shares_rejected}{Colors.RESET}")
    print(f"{Colors.CYAN}{'='*78}{Colors.RESET}")
    
    input("\nPress Enter to exit...")

if __name__ == "__main__":
    main()
