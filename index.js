import axios from "axios";
import {
    configureClash,
    decodeBase64,
    ensureDirectoryAndMmdb,
    logger,
    parseServer,
    runClash,
    sleep,
    testTCPConnectivity,
    writeConfigurationFile
} from "./utils.js";
import express from "express";
import {HttpsProxyAgent} from "https-proxy-agent";

const app = express();


process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";

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
    }, 1000 * 60 * 60 * 5);
}

function getHttpsAgentToUse() {
    const subscriptionDownloadProxy = process.env.SUBSCRIPTION_DOWNLOAD_PROXY;
    if (!subscriptionDownloadProxy) {
        return null;
    }
    return new HttpsProxyAgent(subscriptionDownloadProxy);
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

        let axiosResponse = await axios.get(SUB_URL, {
            httpsAgent: getHttpsAgentToUse(),
            maxRedirects: 100,
        });
        const serversData = (() => {
            if (isBase64(axiosResponse.data)) {
                return decodeBase64(axiosResponse.data)
            } else {
                return axiosResponse.data;
            }
        })().split("\n").filter(x => x && x.trim());

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
        serverToUse = servers.find(server => !blacklistedServers[server.server + ":" + server.port] && testTCPConnectivity(server.server, server.port));
        if (serverToUse == null) {
            console.error("failed to find any server to use");
            process.exit(-1);
            return;
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

    // if serverToUse dies, doLoop again with multiple attempts before marking it dead
    setInterval(async () => {
        if (serverToUse == null) {
            return;
        }

        logger.info("health checking server");

        const maxAttempts = 3;
        let connectivityOK = false;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            logger.info(`Health check attempt ${attempt + 1}`);

            if (testTCPConnectivity(serverToUse.server, serverToUse.port) && (await testActualConnectivity())) {
                connectivityOK = true;
                break;
            }

            if (attempt < maxAttempts - 1) {
                logger.info("Connectivity check failed, waiting before retry...");
                await sleep(5000); // delay of 5 seconds between attempts
            }
        }

        if (!connectivityOK) {
            logger.info("serverToUse failed connectivity after multiple attempts, marking as dead and triggering doLoop");
            blacklistServer(serverToUse);
            await doLoop();
        }
    }, 3 * 60 * 1000);
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

function isBase64(str) {
    const base64Regex = /^[A-Za-z0-9+/=]+$/;

    return base64Regex.test(str.trim());
}
