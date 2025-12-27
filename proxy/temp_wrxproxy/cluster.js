const cluster = require('cluster')

const numCPUs = require('os').cpus().length

if (cluster.isMaster) {
  console.log(`[!] Daemon start. PID: ${process.pid}\n`)
  for (let i = 0; i < numCPUs; ++i) {
    cluster.fork()
  }
  cluster.on('exit', function(deadWorker, code, signal) {
    const worker = cluster.fork()
  })
} else {
  require('./index.js')
}
