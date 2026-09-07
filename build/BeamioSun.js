"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyAndPersistBeamioSunUrl = exports.verifyBeamioSunRequest = exports.verifyBeamioSunUrl = exports.logSunDebug = exports.getQueryParam = void 0;
const node_crypto_1 = require("node:crypto");
const util_1 = require("./util");
const db_1 = require("./db");
const logger_1 = require("./logger");
const hexToBytes = (hex) => Buffer.from(hex, 'hex');
const bytesToHex = (data) => Buffer.from(data).toString('hex').toUpperCase();
const ENC_SV_PREFIX = hexToBytes('C33C00010080');
const MAC_SV_PREFIX = hexToBytes('3CC300010080');
const normalizeHex = (value, expectedLength) => {
    const hex = value.trim().replace(/\s+/g, '').toUpperCase();
    if (!hex || hex.length % 2 !== 0 || /[^0-9A-F]/.test(hex)) {
        throw new Error(`Invalid hex string: ${value}`);
    }
    if (expectedLength != null && hex.length !== expectedLength) {
        throw new Error(`Expected hex length ${expectedLength}, got ${hex.length}: ${value}`);
    }
    return hex;
};
const getQueryParam = (url, key) => {
    const marker = `${key}=`;
    const idx = url.indexOf(marker);
    if (idx < 0)
        return null;
    const start = idx + marker.length;
    const end = url.indexOf('&', start);
    return url.substring(start, end < 0 ? url.length : end);
};
exports.getQueryParam = getQueryParam;
const getBeamioSunConfig = () => {
    const cfg = util_1.masterSetup.beamio_nfc;
    if (!cfg?.key2Hex) {
        throw new Error('masterSetup.beamio_nfc.key2Hex is required');
    }
    return cfg;
};
const shouldDebugSun = (req) => {
    const cfg = getBeamioSunConfig();
    const configEnabled = cfg.debugSun === true;
    const queryEnabled = req != null && (req.query?.debug === '1' ||
        req.query?.debug === 'true' ||
        req.header('x-beamio-sun-debug') === '1');
    return configEnabled || queryEnabled;
};
const shortHex = (value, keep = 8) => {
    if (!value)
        return null;
    if (value.length <= keep * 2)
        return value;
    return `${value.slice(0, keep)}...${value.slice(-keep)}`;
};
/** 供 beamioServer /sun 路由复用，记录 SUN 校验结果 */
const logSunDebug = (stage, req, data) => {
    if (!shouldDebugSun(req))
        return;
    const ip = String(req.headers['x-real-ip'] || req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '');
    const parts = [
        `stage=${stage}`,
        `ip=${ip}`,
        `method=${req.method}`,
        `path=${req.path}`
    ];
    for (const [key, value] of Object.entries(data)) {
        if (value === undefined)
            continue;
        const normalized = value === null
            ? 'null'
            : typeof value === 'string'
                ? value.replace(/\s+/g, ' ').trim()
                : JSON.stringify(value);
        parts.push(`${key}=${normalized}`);
    }
    (0, logger_1.logger)('[beamio.sun]', parts.join(' | '));
};
exports.logSunDebug = logSunDebug;
const aesEcbEncrypt = (key, block16) => {
    const cipher = (0, node_crypto_1.createCipheriv)('aes-128-ecb', key, null);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(block16), cipher.final()]);
};
const aesCbcDecryptNoPadding = (ciphertext, key, iv) => {
    const cipher = (0, node_crypto_1.createDecipheriv)('aes-128-cbc', key, iv);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(ciphertext), cipher.final()]);
};
const leftShiftOneBit = (input) => {
    const out = Buffer.alloc(16, 0);
    let carry = 0;
    for (let i = 15; i >= 0; i -= 1) {
        const b = input[i];
        out[i] = ((b << 1) & 0xFF) | carry;
        carry = (b & 0x80) !== 0 ? 1 : 0;
    }
    return out;
};
const xorInto = (out, a, b) => {
    for (let i = 0; i < 16; i += 1)
        out[i] = a[i] ^ b[i];
};
const xor16 = (a, b) => {
    const out = Buffer.alloc(16, 0);
    xorInto(out, a, b);
    return out;
};
const cmacSubkeys = (l) => {
    const k1 = leftShiftOneBit(l);
    if ((l[0] & 0x80) !== 0)
        k1[15] ^= 0x87;
    const k2 = leftShiftOneBit(k1);
    if ((k1[0] & 0x80) !== 0)
        k2[15] ^= 0x87;
    return [Buffer.from(k1), Buffer.from(k2)];
};
const aesCmac = (key, message) => {
    const zero = Buffer.alloc(16, 0);
    const l = aesEcbEncrypt(key, zero);
    const [k1, k2] = cmacSubkeys(l);
    const blockCount = message.length === 0 ? 1 : Math.ceil(message.length / 16);
    const lastComplete = message.length > 0 && message.length % 16 === 0;
    const mLast = Buffer.alloc(16, 0);
    if (lastComplete) {
        const last = message.subarray((blockCount - 1) * 16, blockCount * 16);
        xorInto(mLast, Buffer.from(last), k1);
    }
    else {
        const start = (blockCount - 1) * 16;
        const last = Buffer.alloc(16, 0);
        const remain = start < message.length ? message.subarray(start) : Buffer.alloc(0);
        Buffer.from(remain).copy(last, 0);
        last[remain.length] = 0x80;
        xorInto(mLast, last, k2);
    }
    let x = Buffer.alloc(16, 0);
    for (let i = 0; i < blockCount - 1; i += 1) {
        const block = Buffer.from(message.subarray(i * 16, (i + 1) * 16));
        x = aesEcbEncrypt(key, xor16(x, block));
    }
    return aesEcbEncrypt(key, xor16(x, mLast));
};
const truncateMac16To8 = (full) => Buffer.from([
    full[1], full[3], full[5], full[7],
    full[9], full[11], full[13], full[15]
]);
const deriveSdmEncIv = (sessionEncKey, ctrLsb) => {
    const ivInput = Buffer.alloc(16, 0);
    ctrLsb.copy(ivInput, 0);
    return aesEcbEncrypt(sessionEncKey, ivInput);
};
const decodePlainPayload = (plain, uidHex, cHex) => {
    const embeddedUidHex = bytesToHex(plain.subarray(0, 7));
    const embeddedCounterMsbHex = bytesToHex(Buffer.from(plain.subarray(7, 10)).reverse());
    if (embeddedUidHex === uidHex && embeddedCounterMsbHex === cHex) {
        return {
            payloadLayout: 'uidCtrTagId',
            tagIdHex: bytesToHex(plain.subarray(10, 18)),
            version: plain[18],
            embeddedUidMatchesInput: true,
            embeddedCounterMatchesInput: true
        };
    }
    return {
        payloadLayout: 'tagIdOnly',
        tagIdHex: bytesToHex(plain.subarray(0, 8)),
        version: plain[8],
        embeddedUidMatchesInput: false,
        embeddedCounterMatchesInput: false
    };
};
const deriveMacInputAscii = (url, uidHex, cHex, eHex) => {
    const uidPos = url.indexOf('uid=');
    const cPos = url.indexOf('c=');
    const ePos = url.indexOf('e=');
    const mPos = url.indexOf('m=');
    if (uidPos >= 0 && cPos > uidPos && ePos > cPos && mPos > ePos) {
        return {
            macInputAscii: `${uidHex}&c=${cHex}&e=${eHex}&m=`,
            macLayout: 'uid_c_e_m'
        };
    }
    return {
        macInputAscii: `${eHex}&c=${cHex}&m=`,
        macLayout: 'e_c_m_uid_suffix'
    };
};
const verifyBeamioSunUrl = async (url) => {
    const cfg = getBeamioSunConfig();
    const uidHex = normalizeHex((0, exports.getQueryParam)(url, 'uid') ?? '', 14);
    const eHex = normalizeHex((0, exports.getQueryParam)(url, 'e') ?? '', 64);
    const cHex = normalizeHex((0, exports.getQueryParam)(url, 'c') ?? '', 6);
    const mHexRaw = (0, exports.getQueryParam)(url, 'm');
    const mHex = mHexRaw ? normalizeHex(mHexRaw, 16) : null;
    const state = await (0, db_1.getBeamioSunLastCounterStateByUid)(uidHex);
    const lastCounterHex = state?.lastCounterHex ?? null;
    const counterState = {
        uidHex,
        lastCounterHex
    };
    const uid = hexToBytes(uidHex);
    const counterMsb = hexToBytes(cHex);
    const counterLsb = Buffer.from(counterMsb).reverse();
    const key2 = hexToBytes(normalizeHex(cfg.key2Hex, 32));
    const sesEncKey = aesCmac(key2, Buffer.concat([ENC_SV_PREFIX, uid, counterLsb]));
    const sesMacKey = aesCmac(key2, Buffer.concat([MAC_SV_PREFIX, uid, counterLsb]));
    const iv = deriveSdmEncIv(sesEncKey, counterLsb);
    const plain = aesCbcDecryptNoPadding(hexToBytes(eHex), sesEncKey, iv);
    if (plain.length !== 32) {
        throw new Error(`Decrypted SDMENCFileData must be 32 bytes, got ${plain.length}`);
    }
    const payload = decodePlainPayload(plain, uidHex, cHex);
    const { macInputAscii, macLayout } = deriveMacInputAscii(url, uidHex, cHex, eHex);
    const expectedMacHex = bytesToHex(truncateMac16To8(aesCmac(sesMacKey, Buffer.from(macInputAscii, 'ascii'))));
    const counterValue = parseInt(cHex, 16);
    const macValid = mHex != null && expectedMacHex === mHex;
    const tagIdMatchesExpected = true;
    const lastCounterVal = lastCounterHex ? parseInt(lastCounterHex, 16) : -1;
    const counterStrictlyNew = counterValue > lastCounterVal;
    // 同 tap 短时 grace：getUIDAssets 成功后 persist 了 counter，nfcTopupPrepare/nfcTopup 复用同一 tap 的 e/c/m，counter 相同。允许 counter === lastCounter 且 lastPersisted 在 120 秒内。
    const SAME_TAP_GRACE_MS = 120_000;
    const sameCounterRecentlyPersisted = !!(counterValue === lastCounterVal && state?.updatedAt && (Date.now() - state.updatedAt.getTime() < SAME_TAP_GRACE_MS));
    const counterFresh = !lastCounterHex || counterStrictlyNew || sameCounterRecentlyPersisted;
    return {
        url,
        uidHex,
        counterHex: cHex,
        counterValue,
        tagIdHex: payload.tagIdHex,
        version: payload.version,
        eHex,
        cHex,
        mHex,
        expectedMacHex,
        macInputAscii,
        macLayout,
        payloadLayout: payload.payloadLayout,
        macValid,
        tagIdMatchesExpected,
        counterFresh,
        embeddedUidMatchesInput: payload.embeddedUidMatchesInput,
        embeddedCounterMatchesInput: payload.embeddedCounterMatchesInput,
        valid: macValid && tagIdMatchesExpected && counterFresh && (payload.payloadLayout === 'tagIdOnly' || (payload.embeddedUidMatchesInput && payload.embeddedCounterMatchesInput)),
        counterState
    };
};
exports.verifyBeamioSunUrl = verifyBeamioSunUrl;
const verifyBeamioSunRequest = async (req, res) => {
    try {
        const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
        const result = await (0, exports.verifyBeamioSunUrl)(url);
        (0, exports.logSunDebug)('verify_ok', req, {
            uidHex: result.uidHex,
            counterHex: result.counterHex,
            lastCounterHex: result.counterState?.lastCounterHex ?? null,
            tagIdHex: result.tagIdHex,
            version: result.version,
            macLayout: result.macLayout,
            payloadLayout: result.payloadLayout,
            macValid: result.macValid,
            counterFresh: result.counterFresh,
            embeddedUidMatchesInput: result.embeddedUidMatchesInput,
            embeddedCounterMatchesInput: result.embeddedCounterMatchesInput,
            valid: result.valid,
            eHex: shortHex(result.eHex),
            mHex: result.mHex,
            expectedMacHex: result.expectedMacHex,
            macInputAscii: result.macInputAscii
        });
        if (result.valid) {
            await (0, db_1.upsertBeamioSunLastCounterByUid)({
                uid: result.uidHex,
                lastCounterHex: result.counterHex
            });
        }
        return res.status(result.valid ? 200 : 403).json(result).end();
    }
    catch (e) {
        (0, exports.logSunDebug)('verify_fail', req, {
            error: e?.message ?? String(e),
            uidHex: req.query?.uid ?? null,
            cHex: req.query?.c ?? null,
            eHex: shortHex(typeof req.query?.e === 'string' ? req.query.e : null),
            mHex: typeof req.query?.m === 'string' ? req.query.m : null
        });
        return res.status(403).json({
            success: false,
            error: e?.message ?? String(e)
        }).end();
    }
};
exports.verifyBeamioSunRequest = verifyBeamioSunRequest;
/** 校验 SUN URL 并在 valid 时持久化 counter。若提供 isTagIdValid 且返回 false，则拒绝非法卡（valid=false）。供 getUIDAssets 等复用 beamio.sun 逻辑。 */
const verifyAndPersistBeamioSunUrl = async (url, options) => {
    const result = await (0, exports.verifyBeamioSunUrl)(url);
    if (!result.valid)
        return result;
    if (options?.isTagIdValid) {
        const tagIdOk = await options.isTagIdValid(result.tagIdHex);
        if (!tagIdOk) {
            return { ...result, valid: false };
        }
    }
    await (0, db_1.upsertBeamioSunLastCounterByUid)({
        uid: result.uidHex,
        lastCounterHex: result.counterHex
    });
    return result;
};
exports.verifyAndPersistBeamioSunUrl = verifyAndPersistBeamioSunUrl;
