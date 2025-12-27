# WRXProxy

## Build from Source

```
git clone https://github.com/WebCryptomining/WRXProxy.git
cd WRXProxy && npm install
```

Remember to create the configuration file `config.json`. Check out the example file `config.example.json`.

## Start Services

You can simply run `cd WRXProxy && npm run start`.

Or use [pm2](http://pm2.io/) (recommended):

```
npm install -g pm2
cd WRXProxy
pm2 start npm --name "cluster debug" -- run start
```

## Deploy with nginx

Minimal example for nginx conf file:


```
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}

upstream websocket {
    server localhost:80; # websocket listening port (defined in `WRXProxy/config.json`)
}

server {
     server_name # your server domain name
     listen 80;
     location / {
         proxy_pass http://websocket;
         proxy_read_timeout 300s;
         proxy_send_timeout 300s;

         proxy_set_header Host $host;
         proxy_set_header X-Real-IP $remote_addr;
         proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

         proxy_http_version 1.1;
         proxy_set_header Upgrade $http_upgrade;
         proxy_set_header Connection $connection_upgrade;
     }
}
```
