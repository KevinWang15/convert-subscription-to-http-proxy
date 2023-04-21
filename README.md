# convert-subscription-to-http-proxy

(toy project, low code quality, do not use in production)

This project converts a subscription (supporting SS / SSR subscriptions) to a http proxy using Clash.

It could also
* do ping tests to the servers in the subscription to skip the dead ones
* do actual HTTP GET health checks through the proxy, and in case the proxy dies, it will try the next server in the subscription

```shell
docker run --restart=always -p 127.0.0.1:8959:7890 -p 127.0.0.1:8960:8080 -e SUB_URL="<give me an SS subscription URL here>" kevinwang15/convert-subscription-to-http-proxy:latest

export https_proxy=http://127.0.0.1:8959
curl https://ifconfig.info
```

If you would like to inform the proxy to switch to the next server, you can do

```shell
curl 127.0.0.1:8960/changeServer
```
