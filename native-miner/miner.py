#!/usr/bin/env python3
"""
Native Python Miner Wrapper for XMRig (RandomX)
Connects to MoneroOcean using XMRig for maximum performance.

This script:
1. Checks for XMRig
2. Downloads it if missing
3. Runs it with optimal settings for MoneroOcean
"""

import os
import sys
import time
import subprocess
import platform
import shutil

# =============================================================================
# VERSION INFO
# =============================================================================
CLIENT_VERSION = "2.6.0"  # Bumped for RandomX support
CLIENT_VERSION_DATE = "2025-12-27"

# =============================================================================
# CONFIGURATION
# =============================================================================
POOL_URL = "gulf.moneroocean.stream:10128"
WALLET = "47ocfRVLCp71ZtNvdrxtAR85VDbNdmUMph5mNWfRf3z2FuRhPFJVm7cReXjM1i1sZmE4vsLWd32BvNSUhP5NQjwmR1zGTuL"
PASS = "x"
ALGO = "rx/0"

def install_xmrig():
    print("⬇️  XMRig not found. Installing...")
    
    # Determine OS
    system = platform.system().lower()
    machine = platform.machine().lower()
    
    if system == "linux":
        setup_script = os.path.join(os.path.dirname(__file__), "setup_xmrig.sh")
        if os.path.exists(setup_script):
            subprocess.run(["bash", setup_script], check=True)
        else:
            print("❌ setup_xmrig.sh not found!")
            sys.exit(1)
    else:
        print(f"❌ Automatic installation not supported for {system}. Please install XMRig manually.")
        sys.exit(1)

def run_xmrig():
    xmrig_path = os.path.join(os.path.dirname(__file__), "xmrig", "xmrig")
    
    if not os.path.exists(xmrig_path):
        install_xmrig()
    
    if not os.path.exists(xmrig_path):
        print("❌ XMRig installation failed.")
        sys.exit(1)
        
    print("=" * 60)
    print(f"  🚀 STARTING RANDOMX MINER (XMRig)")
    print(f"  v{CLIENT_VERSION} - {CLIENT_VERSION_DATE}")
    print("=" * 60)
    print(f"  Pool: {POOL_URL}")
    print(f"  Algo: {ALGO}")
    print("=" * 60)
    
    cmd = [
        xmrig_path,
        "-o", POOL_URL,
        "-u", WALLET,
        "-p", PASS,
        "-a", ALGO,
        "-k", # Keepalive
        "--donate-level=1"
    ]
    
    try:
        subprocess.run(cmd)
    except KeyboardInterrupt:
        print("\n👋 Miner stopped.")

if __name__ == "__main__":
    run_xmrig()
