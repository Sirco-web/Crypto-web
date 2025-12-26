const websockify = require('@maximegris/node-websockify');

// Configuration
const LOCAL_PORT = 8888;
const POOL_HOST = 'pool.supportxmr.com'; // Example pool
const POOL_PORT = 3333;

console.log(`Starting Websockify Bridge...`);
console.log(`Listening on ws://localhost:${LOCAL_PORT}`);
console.log(`Targeting ${POOL_HOST}:${POOL_PORT}`);

websockify({
    source: `localhost:${LOCAL_PORT}`,
    target: `${POOL_HOST}:${POOL_PORT}`
});
