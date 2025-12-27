#!/bin/bash
echo "Downloading XMRig..."
mkdir -p xmrig
cd xmrig

# Detect OS/Arch
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    wget https://github.com/xmrig/xmrig/releases/download/v6.21.0/xmrig-6.21.0-linux-x64.tar.gz
    tar -xvf xmrig-6.21.0-linux-x64.tar.gz
    mv xmrig-6.21.0/xmrig .
    rm -rf xmrig-6.21.0 xmrig-6.21.0-linux-x64.tar.gz
else
    echo "Please download XMRig manually for your OS."
    exit 1
fi

echo "XMRig installed."
echo "Run ./start_xmrig.sh to start mining."
