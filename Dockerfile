FROM ubuntu:22.04

# docker buildx build --platform linux/amd64 . -t ssr-subscription-to-proxy

RUN apt update
RUN apt install -y curl wget netcat lsof
RUN wget http://archive.ubuntu.com/ubuntu/pool/universe/p/polipo/polipo_1.1.1-8_amd64.deb
RUN dpkg -i polipo_1.1.1-8_amd64.deb
RUN curl -sL https://deb.nodesource.com/setup_18.x -o nodesource_setup.sh
RUN chmod +x ./nodesource_setup.sh
RUN ./nodesource_setup.sh
RUN apt install -y nodejs
RUN mkdir /app
ADD ./clash /usr/local/bin/
RUN chmod +x /usr/local/bin/clash
ADD ./Country.mmdb /app
ADD ./package.json /app
RUN cd /app
WORKDIR /app
RUN npm i
ADD ./index.js /app/index.js
ADD ./utils.js /app/utils.js

CMD ["node", "/app/index.js"]
