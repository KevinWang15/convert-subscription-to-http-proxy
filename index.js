import axios from "axios";
import {
    cleanUp,
    configureClash,
    decodeBase64,
    ensureDirectoryAndMmdb, logger,
    parseServer,
    runClash,
    sleep,
    testTCPConnectivity,
    writeConfigurationFile
} from "./utils.js";
import pino from 'pino';
import express from "express";

const app = express();


import HttpsProxyAgent from "https-proxy-agent";

axios.defaults.validateStatus = function () {
    return true;
};


// docker run -p 127.0.0.1:8979:7890 -e SUB_URL="..." kevinwang15/sstp:latest
// docker buildx build --platform linux/amd64 . -t ssr-subscription-to-proxy
// docker run -p 127.0.0.1:8979:7890 -e SUB_URL="..." ssr-subscription-to-proxy
// docker run -p 127.0.0.1:8979:7890 -e SUB_URL="..." kevinwang15/sstp:latest

const blacklistedServers = {};

function blacklistServer(serverToUse) {
    let key = serverToUse.server + ":" + serverToUse.port;
    blacklistedServers[key] = true;
    setTimeout(() => {
        blacklistedServers[key] = false;
    }, 1000 * 60 * 60);
}

(async function main() {

    app.listen(8080, "0.0.0.0", () => {
        console.log("listening on 8080");
    });


    let serverToUse = null;
    let doLoopRunning = false;
    const doLoop = async () => {
        if (doLoopRunning) {
            logger.info("doLoop exited as another doLoop is running");
            return;
        }
        doLoopRunning = true;

        const SUB_URL = process.env.SUB_URL;
        if (!SUB_URL) {
            logger.error("SUB_URL is not set");
            process.exit(1);
        }

        logger.info("starting a new loop");

        let axiosResponse = await axios.get(SUB_URL);
        const serversData = decodeBase64(axiosResponse.data).split("\n").filter(x => x && x.trim());

        cleanUp();

        ensureDirectoryAndMmdb();

        logger.info("parsing servers");
        const servers = serversData.map(parseServer).filter(x => x);
        servers.sort((a, b) => {
            if (a.isPremiumServer && !b.isPremiumServer) {
                return -1;
            } else if (!a.isPremiumServer && b.isPremiumServer) {
                return 1;
            }
            return Math.random() - 0.5;
        });
        serverToUse = servers.find(server => !blacklistedServers[server.server] && testTCPConnectivity(server.server, server.port));
        if (serverToUse == null) {
            throw "failed to find any server to use";
        }
        logger.info("chose server: " + JSON.stringify(serverToUse));

        writeConfigurationFile(serverToUse);

        runClash();
        logger.info("clash is running, waiting 5 seconds until configuration");

        await sleep(1000 * 5);

        await configureClash(serverToUse);
        logger.info("clash is configured");

        await sleep(1000 * 2);

        doLoopRunning = false;

        if (!(await testActualConnectivity())) {
            logger.info("testActualConnectivity failed, do loop again");
            blacklistServer(serverToUse);
            await doLoop();
        }
    };

    app.post("/changeServer",
        function (req, res) {
            logger.info("/changeServer called");
            doLoop();
            res.status(200);
            res.end("");
        });

    logger.info("doing first loop");
    await doLoop();

    // if serverToUse dies, doLoop again
    setInterval(async () => {
        if (serverToUse == null) {
            return;
        }

        logger.info("health checking server");

        if (!testTCPConnectivity(serverToUse.server, serverToUse.port) || !(await testActualConnectivity())) {
            logger.info("serverToUse died, do loop again");
            blacklistServer(serverToUse);
            await doLoop();
        }
    }, 3 * 60 * 1000)
})()


async function testActualConnectivity() {
    logger.info("performing actual connectivity check through proxy");

    const proxyAgent = new HttpsProxyAgent("http://127.0.0.1:7890");
    const axiosInstance = axios.create({
        httpsAgent: proxyAgent,
        timeout: 1000 * 10,
    });

    try {
        const url = process.env["CONNECTIVITY_CHECK_TARGET_URL"] || "https://www.google.com";
        const response = await axiosInstance.get(url);
        if (response.status >= 200) {
            logger.info("testActualConnectivity is good");
            return true;
        }
    } catch (e) {
        logger.info("testActualConnectivity failed", e);
        return false;
    }
    return false;
}

