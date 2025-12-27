#!/bin/bash
set -e

echo "=========================================="
echo "  XMRig Installer for Linux"
echo "=========================================="

# Detect architecture
ARCH=$(uname -m)
echo "Detected architecture: $ARCH"

mkdir -p xmrig
cd xmrig

# Determine download URL based on architecture
if [[ "$ARCH" == "x86_64" ]]; then
    echo "Downloading XMRig for x86_64..."
    XMRIG_URL="https://github.com/xmrig/xmrig/releases/download/v6.21.0/xmrig-6.21.0-linux-x64.tar.gz"
    XMRIG_DIR="xmrig-6.21.0"
elif [[ "$ARCH" == "aarch64" ]] || [[ "$ARCH" == "arm64" ]]; then
    echo "Downloading XMRig for ARM64 (Raspberry Pi 4/5)..."
    # ARM64 build
    XMRIG_URL="https://github.com/xmrig/xmrig/releases/download/v6.21.0/xmrig-6.21.0-linux-static-x64.tar.gz"
    # Note: Official ARM64 builds may need to be compiled from source
    echo "Note: For best performance on ARM64, consider building from source."
    XMRIG_DIR="xmrig-6.21.0"
elif [[ "$ARCH" == "armv7l" ]] || [[ "$ARCH" == "armhf" ]]; then
    echo "Downloading XMRig for ARMv7 (Raspberry Pi 3/older)..."
    # ARMv7 needs compilation from source or pre-built
    echo "ARMv7 requires building from source. See README."
    exit 1
else
    echo "Unsupported architecture: $ARCH"
    exit 1
fi

# Download and extract
wget -q --show-progress "$XMRIG_URL" -O xmrig.tar.gz
tar -xzf xmrig.tar.gz

# Move binary
if [ -d "$XMRIG_DIR" ]; then
    mv "$XMRIG_DIR/xmrig" .
    chmod +x xmrig
    rm -rf "$XMRIG_DIR" xmrig.tar.gz
fi

echo ""
echo "=========================================="
echo "  XMRig installed successfully!"
echo "=========================================="
echo "Run: ./start_xmrig.sh to start mining"
