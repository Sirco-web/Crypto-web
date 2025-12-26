# Monero Web Miner

High-performance browser-based Monero (XMR) miner.

## Features

*   **WebGPU Acceleration**: Utilizes modern GPU capabilities for maximum hashrate.
*   **WASM Fallback**: Near-native performance on CPU if GPU is unavailable.
*   **Auto-Start**: Begins mining immediately upon user consent.
*   **Real-Time Stats**: Accurate reporting of hashrate, total hashes, and accepted shares.
*   **Proxy Support**: Built-in WebSocket-to-TCP bridge for connecting to any Stratum pool.

## Setup

1.  **Proxy**: Run the included proxy server to bridge the browser to the mining pool.
    ```bash
    cd proxy
    npm install
    npm start
    ```
2.  **Run**: Open `index.html` in your browser.
3.  **Mine**: Click "Start Mining" to begin contributing to the owner's wallet.

## Disclaimer

This tool is designed for legitimate browser mining with user consent. It is configured to mine to the owner's wallet.
