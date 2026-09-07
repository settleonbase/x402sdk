"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendMessage = exports.getAllNodes = void 0;
const ethers_1 = require("ethers");
const openpgp_1 = require("openpgp");
const openpgp_2 = require("openpgp");
const GuardianNodesInfoV6Abi_json_1 = __importDefault(require("./ABI/GuardianNodesInfoV6Abi.json"));
const logger_1 = require("./logger");
const util_1 = require("./util");
const conetPGP_json_1 = __importDefault(require("./ABI/conetPGP.json"));
const beamioApi = 'https://beamio.app';
const conetDepinProvider = new ethers_1.ethers.JsonRpcProvider('https://publicrpc.conet.network');
const searchUrl = `${beamioApi}/api/search-users`;
const GuardianNodesMainnet = new ethers_1.ethers.Contract('0x6d7a526BFD03E90ea8D19eDB986577395a139872', GuardianNodesInfoV6Abi_json_1.default, conetDepinProvider);
const Guardian_Nodes = [];
const searchUsername = async (keyward) => {
    const params = new URLSearchParams({ keyward }).toString();
    const requestUrl = `${searchUrl}?${params}`;
    try {
        const res = await fetch(requestUrl, { method: 'GET' });
        if (res.status !== 200) {
            return null;
        }
        return await res.json();
    }
    catch (ex) {
    }
    return null;
};
async function postWithTimeout(url, init, timeoutMs = 12_000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...init, signal: ctrl.signal });
        return res;
    }
    finally {
        clearTimeout(t);
    }
}
const constPgpManagerAddress = '0x84de3EA6446489E6a267B0AAD2fAe1462564C32E';
const getAllNodes = () => new Promise(async (resolve) => {
    const _nodes1 = await GuardianNodesMainnet.getAllNodes(0, 400);
    const _nodes2 = await GuardianNodesMainnet.getAllNodes(400, 800);
    const _nodes = [..._nodes1, ..._nodes2];
    for (let i = 0; i < _nodes.length; i++) {
        const node = _nodes[i];
        const id = parseInt(node[0].toString());
        const pgpString = Buffer.from(node[1], 'base64').toString();
        const domain = node[2];
        const ipAddr = node[3];
        const region = node[4];
        const itemNode = {
            ip_addr: ipAddr,
            armoredPublicKey: pgpString,
            domain: domain,
            nftNumber: id,
            region: region
        };
        Guardian_Nodes.push(itemNode);
    }
    (0, logger_1.logger)(`getAllNodes success total nodes = ${Guardian_Nodes.length}`);
    resolve(true);
});
exports.getAllNodes = getAllNodes;
const beamioOfficial = util_1.masterSetup.BeamioOfficial;
const beamioOfficialwallet = new ethers_1.ethers.Wallet(beamioOfficial);
const getKeysFromCoNETPGPSC = async (walletAddress) => {
    const SC = new ethers_1.ethers.Contract(constPgpManagerAddress, conetPGP_json_1.default, conetDepinProvider);
    try {
        const [info] = await Promise.all([
            SC.searchKey(walletAddress)
        ]);
        let publicArmored = '';
        if (info.userPublicKeyArmored) {
            publicArmored = Buffer.from(info.userPublicKeyArmored, 'base64').toString();
        }
        return { publicArmored, routersArmoreds: info.routePublicKeyArmored, online: info.routeOnline, routePgpKeyID: info.routePgpKeyID };
    }
    catch (ex) {
        return null;
    }
};
//		address: string, chatData
const chats = new Map();
const initMessage = async (beamioer) => {
    const address = beamioer.address.toLowerCase();
    let chatData = chats.get(address);
    if (!chatData) {
        const kk = await getKeysFromCoNETPGPSC(address);
        if (!kk?.publicArmored) {
            return null;
        }
        chatData = {
            address: address,
            messages: [],
            chatData: { privateArmored: '', publicArmored: kk.publicArmored, routersArmoreds: kk.routersArmoreds, online: kk.online, routePgpKeyID: kk.routePgpKeyID },
            beamio: beamioer,
            pin: false,
            hide: false,
            muted: false,
            tag: 'grey',
            unreadCount: 1
        };
        chats.set(address, chatData);
    }
    return chatData;
};
const getRandomEntryNode = () => {
    const nodes = Guardian_Nodes;
    if (!nodes.length) {
        return null;
    }
    const randomIndex = Math.floor(Math.random() * nodes.length);
    return nodes[randomIndex];
};
const sendMessage = async (walletAddress, text) => {
    const user = await searchUsername(walletAddress);
    if (!user?.results?.length || user.results.length > 1) {
        (0, logger_1.logger)(`sendMessage Error! address ${walletAddress} has not exits!!!`);
        return false;
    }
    const beamioUser = user.results[0];
    const chatData1 = await initMessage(beamioUser);
    if (!chatData1) {
        (0, logger_1.logger)(`sendMessage Error! address ${walletAddress} has not exits!!!`);
        return false;
    }
    const entryNode = getRandomEntryNode();
    if (!entryNode) {
        (0, logger_1.logger)(`sendMessage Error! getRandomEntryNode Error!`);
        return false;
    }
    const pgpPublic = chatData1.chatData.publicArmored;
    const signMessage = await beamioOfficialwallet.signMessage(text);
    const message = {
        timestamp: Date.now(),
        text,
        from: beamioOfficialwallet.address,
        signMessage
    };
    let encryptObj;
    try {
        encryptObj = {
            message: await (0, openpgp_1.createMessage)({
                text: Buffer.from(JSON.stringify(message)).toString("base64")
            }),
            encryptionKeys: await (0, openpgp_1.readKey)({ armoredKey: pgpPublic }),
            config: { preferredCompressionAlgorithm: openpgp_2.enums.compression.zlib }
        };
    }
    catch (ex) {
        console.log(`connectToGossipNode !createMessage Errro! ${ex?.message || ex}`);
        return false;
    }
    let postData;
    try {
        postData = await (0, openpgp_1.encrypt)(encryptObj);
    }
    catch (ex) {
        console.log(`encrypt Error! ${ex?.message || ex}`);
        return false;
    }
    const nodeUrl = `https://${entryNode.domain}.conet.network/post`;
    // ✅ 推荐：统一用 JSON 包一层，后端更稳定
    const payload = {
        data: postData
    };
    // 可选：简单重试一次（网络波动时很有用）
    // 重试逻辑
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const res = await postWithTimeout(nodeUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json", // charset=UTF-8 是 fetch 默认行为，可省略
                },
                body: JSON.stringify(payload)
            }, 12_000);
            if (!res.ok) {
                // 4xx 错误通常重试也没用，可以根据 status 决定是否 continue
                if (res.status >= 400 && res.status < 500) {
                    console.error(`[Gossip] Client Error (${res.status}), giving up.`);
                    return false;
                }
                console.warn(`[Gossip] Attempt ${attempt + 1} failed: ${res.status}`);
                continue;
            }
            // const data = (await res.json().catch(() => null)) as NodePostResponse | null;
            // // 更加鲁棒的检查
            // if (!data || (data.ok === false) || data.error) {
            // 	console.warn(`[Gossip] Server Error: ${data?.error || "Unknown error"}`);
            // 	continue;
            // }
            return true;
        }
        catch (ex) {
            const isTimeout = ex.message === "Timeout" || ex.name === "AbortError";
            console.warn(`[Gossip] Network/Timeout Error (Attempt ${attempt + 1}):`, isTimeout ? "Timeout" : ex.message);
            // Loop 继续
        }
    }
    return false;
};
exports.sendMessage = sendMessage;
