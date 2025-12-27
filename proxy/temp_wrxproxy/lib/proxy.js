const debug = require('debug')
const Miner = require('./miner')
const Pool = require('./pool')
const WebSocket = require('ws');

class Proxy {
  constructor (options) {
    this._user = null
    this._taskID = null
    this._hashes = 0
    this._info = options.info
    this._miner = null
    this._minerConfig = options.miner
    this._pool = null
    this._poolConfig = options.pool
    this._currentJob = null
    this.debug = debug('proxy')
  }

  start () {
    this.debug('Start')
    this._miner = new Miner(this._minerConfig)
    this._miner.start()
    this._pool = new Pool(this._poolConfig)
    this._pool.start()
    this._subscribe()
  }

  close () {
    // this.debug('Close')
    if (this._miner) this._miner.close()
    // if (this._pool) this._pool.close()
  }

  _reply (type, params) {
    if (this._miner._socket && this._miner._socket.readyState == WebSocket.OPEN) {
      this._miner.send(type, params)
    }
  }

  _commit (method, params) {
    this._pool.send(method, params)
  }

  _onAuth (params) {
    // this._user = params.type === 'user' ?  params.user : 'Anonymous'
    this._commit('login', {
      login: this._info.wallet,
      pass: this._info.password,
      agent: 'wrxproxy'
    })
  }

  _onSubmit (params) {
    this._commit('submit', {
      id: this._taskID,
      job_id: params.job_id,
      nonce: params.nonce,
      result: params.result
    })
  }

  _onClose () {
    this.close()
  }

  _onAuthed (result) {
    this._taskID = result.id
    this._reply('authed', {
      hashes: this._hashes
    })
    this._currentJob = result.job
    this._reply('job', result.job)
  }

  _onAccepted () {
    this._hashes++
    this._reply('hash_accepted', {
      hashes: this._hashes
    })
  }

  _onJob (params) {
    this._currentJob = params
    this._reply('job', params)
  }

  _onError (error) {
    this.close()
  }

  _onBanned (postID) {
    this._reply('banned', {
      banned: postID
    })
  }

  _onMinerConnect () {
    if (this._currentJob) {
      this._reply('job', this._currentJob)
    }
  }

  _subscribe () {
    this._miner.on('connected', this._onMinerConnect.bind(this))
    this._miner.on('submit', this._onSubmit.bind(this))
    this._miner.on('error', this._onError.bind(this))
    this._miner.on('close', this._onClose.bind(this))
    this._pool.on('connected', this._onAuth.bind(this))
    this._pool.on('auth', this._onAuth.bind(this))
    this._pool.on('authed', this._onAuthed.bind(this))
    this._pool.on('accepted', this._onAccepted.bind(this))
    this._pool.on('job', this._onJob.bind(this))
    this._pool.on('banned', this._onBanned.bind(this))
    this._pool.on('error', this._onError.bind(this))
    this._pool.on('close', this._onClose.bind(this))
  }
}

module.exports = Proxy
