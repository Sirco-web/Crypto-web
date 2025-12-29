// ============================================================================
// MINER CONFIGURATION - Edit these values for your setup
// ============================================================================
// All scripts will read from this central config file

const CONFIG = {
  // Your Monero wallet address
  WALLET: '42C9fVZdev5ZW7k6NmNGECVEpy2sCkA8JMpA1i2zLxUwCociGC3VzAbJ5WoMUFp3qeSqpCuueTvKgXZh8cnkbj957aBZiAB',
  
  // Worker name (shows up in pool stats)
  WORKER_NAME: 'sirco_browser_miner',
  
  // Proxy server URL - Change this to your deployed server URL
  // For Koyeb: wss://your-app-name.koyeb.app/proxy
  // For Render: wss://your-app-name.onrender.com/proxy
  // For local: ws://localhost:8892/proxy
  PROXY_URL: 'wss://respectable-gilemette-timco-f0e524a9.koyeb.app/proxy',
  
  // Pool settings
  POOL: 'gulf.moneroocean.stream:10001',
  
  // Mining algorithm
  ALGORITHM: 'rx/0',
  
  // Version info
  VERSION: '4.3.7'
};
