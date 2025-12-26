# How to Setup Your Own Wallet and Pool Connection

To make this "Owner Mode" miner actually work and send funds to you, you need two things:
1.  A **Wallet** to receive the coins.
2.  A **Pool Connection** (Proxy) that allows web browsers to talk to the mining network.

## Step 1: Get a Monero (XMR) Wallet

You need an address to receive your mining rewards.

1.  **Mobile (Easiest)**: Download **Cake Wallet** or **Monerujo** from your phone's app store.
2.  **Desktop (Official)**: Go to [getmonero.org](https://www.getmonero.org/downloads/) and download the **GUI Wallet**.
3.  **Create a Wallet**: Follow the instructions in the app.
4.  **Copy Address**: Find your "Receive" address. It will be a long string starting with `4` or `8`.
    *   *Example*: `44AFFq5kSiGBoZ4NMDwYtN18ttxtA9cti8jD8bsCrkdpd5E5Xdt...`

**Action**: Paste this address into the `OWNER_WALLET` variable in `app.js`.

---

## Step 2: The "Pool" Problem

Web browsers cannot connect directly to standard mining pools.
*   **Browsers** speak `WebSocket` (wss://).
*   **Mining Pools** speak `TCP` (stratum+tcp://).

You cannot just put `stratum+tcp://pool.supportxmr.com:3333` in the code. It will fail. **You need a "Bridge" (Proxy).**

## Step 3: Setting up a Free Bridge (Proxy)

To do this for free, you need a small server to act as the middleman.

### Option A: Use a Free Cloud Server (Recommended)
1.  Sign up for **Oracle Cloud Free Tier** (generous) or **Google Cloud Free Tier**.
2.  Create a small Linux VM (Ubuntu).
3.  SSH into your server.

### Option B: Run Locally (For testing only)
If you just want to test on your own network, you can run the proxy on your own computer.

### How to Install the Proxy (Monero-Web-Miner-Proxy)
There are several open-source proxies. A popular one for web mining is `xmrig-proxy` or a Node.js based proxy.

**Using a simple Node.js Proxy:**

1.  **Install Node.js** on your server.
2.  **Clone a proxy repo** (search GitHub for "monero-stratum-bridge" or "web-miner-proxy").
3.  **Configure it**:
    *   **Pool**: `pool.supportxmr.com:3333` (or any other pool).
    *   **Bind Port**: `8888` (or whatever port you want).
4.  **Run it**.

**Example Configuration (Conceptual):**
```json
{
  "pool": "pool.supportxmr.com",
  "port": 3333,
  "bind": "0.0.0.0",
  "bind_port": 8888,
  "ssl": false
}
```

## Step 4: Connect the Web Miner

Once your proxy is running at `ws://your-server-ip:8888`:

1.  Open `app.js` in this project.
2.  Update `POOL_URL`:
    ```javascript
    const POOL_URL = "ws://your-server-ip:8888";
    // Or "wss://" if you set up SSL (recommended for production)
    ```

## Summary

1.  **User** (Browser) -> sends work via WebSocket -> **Your Proxy**
2.  **Your Proxy** -> translates to TCP -> **Real Mining Pool** (e.g., SupportXMR)
3.  **Real Mining Pool** -> sends XMR -> **Your Wallet**
