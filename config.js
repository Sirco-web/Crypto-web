// ============================================================================
// MINER CONFIGURATION - Edit these values for your setup
// ============================================================================

const CONFIG = {
  // Your Monero wallet address
  WALLET: '43fx9ijTgKESpbsYjukgHiNDLqoZXnkuZVyBnRkNmbCFDz43us6qtdNM1nSSYJ1AUdUSXbTBn2k8rVWBWB4zRfDaGaiBYUQ',
  
  // Worker name (shows up in pool stats)
  WORKER_NAME: 'sirco_browser_miner',
  
  // Proxy server URL - Change this to your deployed server URL
  // For Koyeb: wss://your-app-name.koyeb.app/proxy
  // For Render: wss://your-app-name.onrender.com/proxy
  // For local: ws://localhost:8892/proxy
  PROXY_URL: 'wss://respectable-gilemette-timco-f0e524a9.koyeb.app',
  
  // Pool settings (configured on server side)
  POOL: 'gulf.moneroocean.stream:10128'
};
