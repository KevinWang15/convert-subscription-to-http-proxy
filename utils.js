import crypto from "crypto";
import {execFileSync, spawn} from "child_process";
import dedent from "dedent";
import fs from "fs";
import axios from "axios";
import base64url from "base64url";
import pino from "pino";

const logger = pino({
    transport: {
        target: 'pino-pretty'
    },
})

export function sha1sum(text) {
    const shasum = crypto.createHash('sha1');
    shasum.update(text);
    return shasum.digest('hex');
}

export function decodeFormUrlEncoded(encoded) {
    const result = {};
    for (const pair of encoded.split("&")) {
        const [key, value] = pair.split("=");
        result[key] = value;
    }
    return result;
}

export function decodeBase64(str) {
    return Buffer.from(str, 'base64').toString('utf8');
}

export function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms)
    })
}

export function testTCPConnectivity(host, port) {
    logger.info("testTCPConnectivity", host, port);
    try {
        execFileSync("nc", ["-z", host, port], {
            encoding: "utf8",
            timeout: 3000,
        });
        return true;
    } catch (e) {
        return false;
    }
}

function parseSSRServer(addr) {
    const base64 = addr.substring(6);
    const decoded = decodeBase64(base64);
    const segments = decoded.split("/?");
    const [server, port, protocol, cipher, obfs, passwordBase64Encoded] = segments[0].split(":");
    const password = decodeBase64(passwordBase64Encoded);
    const params = decodeFormUrlEncoded(segments[1]);
    for (let key of Object.keys(params)) {
        params[key] = decodeBase64(params[key]);
    }

    const ret = {
        server,
        port,
        protocol,
        cipher,
        obfs,
        password,
        params,
        type: "ssr"
    };

    ret['proxyName'] = sha1sum(JSON.stringify(ret));
    return ret
}

function parseSSServer(addr) {
    let isPremiumServer = false;
    if (addr.indexOf("#") >= 0) {
        let hashContent = decodeURIComponent(addr.substring(addr.indexOf("#") + 1));
        addr = addr.substring(0, addr.indexOf("#"));
        if (hashContent.indexOf("[Premium]") >= 0) {
            isPremiumServer = true;
        }
    }

    const segments = addr.substring(5).split("/?");
    const firstSegments = segments[0].split("@");
    const [method, password] = base64url.decode(firstSegments[0]).split(":");
    const [server, port] = firstSegments[1].split(":");
    let decodedParams = segments[1] ? decodeURIComponent(segments[1]) : "";

    const params = {};
    if (decodedParams) {
        decodedParams.split(";").forEach(x => {
            const [key, value] = x.split("=");
            params[key] = value;
        })
    }

    const ret = {
        server,
        port,
        password,
        method,
        params,
        type: "ss",
        isPremiumServer
    };

    ret['proxyName'] = sha1sum(JSON.stringify(ret));
    return ret
}

export function parseServer(addr) {
    if (addr.startsWith("ssr://")) {
        return parseSSRServer(addr);
    }

    if (addr.startsWith("ss://")) {
        return parseSSServer(addr);
    }

    return null;
}

export function buildConfigurationYamlFromServer(server) {
    if (server.type === 'ssr') {
        return dedent(`
    port: 7890
    socks-port: 7891
    mode: global
    allow-lan: true
    external-controller: 127.0.0.1:9090
    proxies:
      - name: ${server.proxyName}
        type: ssr
        server: ${server.server}
        port:  "${server.port}"
        cipher: ${server.cipher}
        password: ${server.password}
        protocol: ${server.protocol}
        protocol-param: '${server.params.protoparam}'
        obfs: '${server.obfs}'
        obfs-param: '${server.params.obfsparam}'`)
    } else if (server.type === 'ss') {
        return dedent(`
    port: 7890
    socks-port: 7891
    mode: global
    allow-lan: true
    external-controller: 127.0.0.1:9090
    proxies:
      - name: ${server.proxyName}
        type: ss
        server: ${server.server}
        port:  ${server.port}
        cipher: ${server.method}
        password: ${server.password}
        ${server.params.obfs ? `
        plugin: obfs
        plugin-opts:
            mode: ${server.params.obfs}
            host: ${server.params['obfs-host']}
        ` : ''}
        
`)
    } else {
        throw "unknown server type"
    }
}

export function ensureDirectoryAndMmdb() {
    fs.mkdirSync("/root/.config/clash", {recursive: true});
    if (!fs.existsSync("/root/.config/clash/Country.mmdb")) {
        fs.copyFileSync("./Country.mmdb", "/root/.config/clash/Country.mmdb");
    }
}

export function writeConfigurationFile(server) {
    fs.writeFileSync("/root/.config/clash/config.yaml", buildConfigurationYamlFromServer(server))
}

let clashProcess = null;

export function runClash() {
    // If an existing process is running, kill it before starting a new one
    if (clashProcess) {
        logger.info("killing the last clash");
        clashProcess.kill();
    }

    // Spawn the new clash process
    clashProcess = spawn("clash", ["-d", "/root/.config/clash"], {
        stdio: "inherit",
    });

    // Handle process exit to avoid zombies
    clashProcess.on("exit", (code, signal) => {
        console.log(`Clash process exited with code ${code}, signal ${signal}`);
        clashProcess = null; // clear the reference
    });
}

export async function configureClash(server) {
    const resp = await axios.request({
        url: 'http://127.0.0.1:9090/proxies/GLOBAL',
        method: "PUT",

        data: {name: server.proxyName}
    });

    if (+(resp.status / 100).toFixed(0) !== 2) {
        logger.error(`configureClash failed with ${resp.status} ${JSON.stringify(resp.data)}`);
        process.exit(1);
    }
}

export {logger};
