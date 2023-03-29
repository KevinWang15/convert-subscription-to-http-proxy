import axios from "axios";
import {
    cleanUp,
    configureClash,
    decodeBase64,
    ensureDirectoryAndMmdb,
    parseServer,
    runClash,
    sleep,
    testTCPConnectivity,
    writeConfigurationFile
} from "./utils.js";
import HttpsProxyAgent from "https-proxy-agent";

// docker run -p 127.0.0.1:8979:7890 -e SUB_URL="..." kevinwang15/sstp:latest
// docker buildx build --platform linux/amd64 . -t ssr-subscription-to-proxy
// docker run -p 127.0.0.1:8979:7890 -e SUB_URL="..." ssr-subscription-to-proxy
// docker run -p 127.0.0.1:8979:7890 -e SUB_URL="..." kevinwang15/sstp:latest

const blacklistedServers = {};

(async function main() {
    let serverToUse = null;
    let doLoopRunning = false;
    const doLoop = async () => {
        if (doLoopRunning) {
            console.log("doLoop exited as another doLoop is running");
            return;
        }
        doLoopRunning = true;

        const SUB_URL = process.env.SUB_URL;
        if (!SUB_URL) {
            console.log("SUB_URL is not set");
            process.exit(1);
        }

        console.log("starting a new loop");

        let axiosResponse = await axios.get(SUB_URL);
        const serversData = decodeBase64(axiosResponse.data).split("\n").filter(x => x && x.trim());

        cleanUp();

        ensureDirectoryAndMmdb();

        console.log("parsing servers");
        const servers = serversData.map(parseServer).filter(x => x);
        servers.sort(() => Math.random() - 0.5);
        serverToUse = servers.find(server => !blacklistedServers[server.server] && testTCPConnectivity(server.server, server.port));
        if (serverToUse == null) {
            throw "failed to find any server to use";
        }
        console.log("chose server: ", serverToUse);

        writeConfigurationFile(serverToUse);

        runClash();
        console.log("clash is running, waiting 5 seconds until configuration");

        await sleep(1000 * 5);

        await configureClash(serverToUse);
        console.log("clash is configured");

        await sleep(1000 * 2);

        doLoopRunning = false;

        if (!(await testActualConnectivity())) {
            console.log("testActualConnectivity failed, do loop again");
            blacklistedServers[serverToUse.server] = true;
            await doLoop();
        }
    };

    await doLoop();

    // if serverToUse dies, doLoop again
    setInterval(async () => {
        if (serverToUse == null) {
            return;
        }

        console.log("health checking server");

        if (!testTCPConnectivity(serverToUse.server, serverToUse.port) || !(await testActualConnectivity())) {
            console.log("serverToUse died, do loop again");
            blacklistedServers[serverToUse.server] = true;
            await doLoop();
        }
    }, 3 * 60 * 1000)
})()


async function testActualConnectivity() {
    console.log("performing actual connectivity check through proxy");

    const proxyAgent = new HttpsProxyAgent("http://127.0.0.1:7890");
    const axiosInstance = axios.create({
        httpsAgent: proxyAgent,
        timeout: 1000 * 10,
    });

    try {
        const response = await axiosInstance.get("https://www.google.com");
        if (response.status === 200) {
            console.log("testActualConnectivity is good");
            return true;
        }
    } catch (e) {
        console.log("testActualConnectivity failed", e);
        return false;
    }
    return false;
}
