const debug = require('debug')
const net = require('net')
const WebSocket = require('ws');

class Pool {
  constructor (options) {
    this._host = options.host
    this._port = options.port
    this._socket = null
    this._postID = Math.floor(Math.random() * 100 + 1) // XXX
    this._dataBuffer = ''
    this._eventListeners = {
      connected: [],
      authed: [],
      job: [],
      accepted: [],
      banned: [],
      close: [],
      error: []
    }
    this._connectionInterval = null
    this.debug = debug('pool')
  }

  start () {
    this._connect()
    this._connectionInterval = setInterval(this._connect.bind(this), 1e3)
  }

  close () {
    if (this._socket && this._socket.destroyed === false) this._socket.destroy()
  }

  on (event, callback) {
    if (this._eventListeners[event]) {
      this._eventListeners[event].push(callback)
    }
  }

  send (method, params) {
    this._postID
    let data = {
      method: method,
      params: params,
      id: this._postID
    }
    this._socket.write(JSON.stringify(data) + '\n')
    this.debug(`Sent: ${JSON.stringify(data)}`)
  }

  _emit (event, params) {
    const listeners = this._eventListeners[event]
    if (listeners && listeners.length) {
      for (let i = 0; i < listeners.length; ++i) {
        listeners[i](params)
      }
    }
  }

  _connect () {
    if (!this._socket || this._socket.readyState == WebSocket.CLOSED || this._socket.readyState == WebSocket.CLOSING) {
      this._socket = net.connect(this._port, this._host)
      this._socket.on('connect', this._onConnection.bind(this))
    }
  }

  _onConnection() {
    this.debug('Connected')
    this._socket.on('data', this._onData.bind(this))
    this._socket.on('error', this._onError.bind(this))
    this._socket.on('close', this._onClose.bind(this))
    this._emit('connected')
  }

  _onData (data) {
    this._dataBuffer += data
    if (this._dataBuffer.indexOf('\n') !== -1) {
      let messages = this._dataBuffer.split('\n')
      let incomplete = this._dataBuffer.slice(-1) === '\n' ? '' : messages.pop()
      for (let message of messages) {
        if (message.trim() === '') {
          continue
        }
        this._trigger(JSON.parse(message))
      }
      this._dataBuffer = incomplete
    }
  }

  _trigger (data) {
    this.debug(`Received: ${JSON.stringify(data)}`)

    if (data.id === this._postID && data.result) {
      if (data.result.id) this._emit('authed', data.result)
      else if (data.result.status === 'OK') this._emit('accepted')
    }

    if (data.id == this._postID && data.error) {
      if (data.error.code === -1) this._emit('error', data.error)
      else this._emit('banned', this._postID)
    }

    if (data.method === 'job') this._emit('job', data.params)
  }

  _onError (error) {
    this.debug(`Error: ${error}`)
    this._emit('error')
    this.close()
  }

  _onClose () {
    this.debug(`Close`)
    this._emit('close')
    this._socket = null
  }
}

module.exports = Pool
