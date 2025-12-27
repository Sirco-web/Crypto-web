
const Proxy = require('./lib/proxy')

const config = require('./config.json')

const proxy = new Proxy(config)

proxy.start()
