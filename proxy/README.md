# Mining Proxy Server

This Node.js server acts as a bridge between your web browser (WebSocket) and the real mining pool (TCP).

## Setup

1.  Open a terminal in this folder:
    ```bash
    cd proxy
    ```

2.  Install dependencies:
    ```bash
    npm install
    ```

3.  Run the server:
    ```bash
    npm start
    ```

The proxy will listen on `ws://localhost:8888` and forward traffic to `pool.supportxmr.com:3333` (default).

## Configuration

Edit `server.js` to change the pool address or port if needed.
