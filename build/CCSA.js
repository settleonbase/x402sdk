"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BEAMIO_USER_CARD_EIP170_MAX_BYTES = void 0;
exports.resolveBeamioUserCardLibraryAddresses = resolveBeamioUserCardLibraryAddresses;
exports.assertBeamioUserCardLinkedDeployedBytecodeFitsEip170 = assertBeamioUserCardLinkedDeployedBytecodeFitsEip170;
exports.createBeamioCard = createBeamioCard;
exports.buildBeamioUserCardInitCode = buildBeamioUserCardInitCode;
exports.createBeamioCardWithFactory = createBeamioCardWithFactory;
exports.resolveCreateCardTierUpgradeByBalance = resolveCreateCardTierUpgradeByBalance;
exports.normalizeTiersForCreateCard = normalizeTiersForCreateCard;
exports.isBasicOnlyCreateCardTiers = isBasicOnlyCreateCardTiers;
exports.encodeCreateCardCollectionWithInitCodeAndTiersCalldata = encodeCreateCardCollectionWithInitCodeAndTiersCalldata;
exports.sendCreateCardCollectionWithInitCodeAndTiers = sendCreateCardCollectionWithInitCodeAndTiers;
exports.encodeAppendTierForCardCalldata = encodeAppendTierForCardCalldata;
exports.sendAppendTierForCard = sendAppendTierForCard;
exports.collectCreateCardChainDebugSnapshot = collectCreateCardChainDebugSnapshot;
exports.createBeamioCardWithFactoryReturningHash = createBeamioCardWithFactoryReturningHash;
const ethers_1 = require("ethers");
const BeamioUserCardFactoryPaymaster_json_1 = __importDefault(require("./ABI/BeamioUserCardFactoryPaymaster.json"));
const BeamioFactoryPaymasterABI = (Array.isArray(BeamioUserCardFactoryPaymaster_json_1.default) ? BeamioUserCardFactoryPaymaster_json_1.default : BeamioUserCardFactoryPaymaster_json_1.default.abi ?? []);
const BeamioUserCardArtifact_json_1 = __importDefault(require("./ABI/BeamioUserCardArtifact.json"));
const chainAddresses_1 = require("./chainAddresses");
const beamioUserCardBeaconInitCode_1 = require("./beamioUserCardBeaconInitCode");
const linkBeamioUserCardBytecode_js_1 = require("./linkBeamioUserCardBytecode.js");
const createCardChainTrace_1 = require("./createCardChainTrace");
const createCardTiersDebug_1 = require("./createCardTiersDebug");
const membershipFeeMetadata_1 = require("./membershipFeeMetadata");
const CURRENCY_TO_ENUM = {
    CAD: 0,
    USD: 1,
    JPY: 2,
    CNY: 3,
    USDC: 4,
    HKD: 5,
    EUR: 6,
    SGD: 7,
    TWD: 8,
};
/** 统一 metadata base（ERC-1155 / Base Explorer 约定）。与 Factory metadataBaseURI 一致，合约 uri() 重写为 0x{address(this)}{id}.json。 */
const BEAMIO_METADATA_BASE_URI = 'https://beamio.app/api/metadata/0x';
/** createCardCollectionWithInitCode 可能 revert 的 custom errors（Factory / Deployer / BeamioUserCard），用于解析链上返回的 data */
const CREATE_CARD_ERROR_IFACE = new ethers_1.ethers.Interface([
    'error DEP_NotFactory()',
    'error DEP_InvalidFactory()',
    'error DEP_NotOwner()',
    'error BM_DeployFailed()',
    'error BM_DeployFailedAtStep(uint8 step)',
    'error BM_ZeroAddress()',
    'error F_BadDeployedCard()',
    'error F_AlreadyRegistered()',
    'error UC_GlobalMisconfigured()',
    'error UC_ResolveAccountFailed(address eoa, address aaFactory, address acct)',
    'error UC_UnauthorizedGateway()',
    'error UC_RedeemModuleZero()',
    'error UC_TierMinZero()',
]);
/**
 * 解析 createCard 链上 revert 的 data，返回可读的 error 名称（及参数），便于日志定位原因。
 * 若无法解析则返回 null。
 */
function parseCreateCardRevertData(data) {
    if (data == null)
        return null;
    const hex = typeof data === 'string' ? data : (data instanceof Uint8Array ? ethers_1.ethers.hexlify(data) : null);
    if (!hex || !hex.startsWith('0x') || hex.length < 10)
        return null;
    try {
        const parsed = CREATE_CARD_ERROR_IFACE.parseError(hex);
        if (!parsed)
            return null;
        const name = parsed.name;
        const args = parsed.args;
        if (args && args.length > 0) {
            return `${name}(${args.map((a) => String(a)).join(', ')})`;
        }
        return name;
    }
    catch {
        return null;
    }
}
/** 当 decoded 为 BM_DeployFailed 或 BM_DeployFailedAtStep(step) 时追加的排查说明 */
function createCardRevertHint(decoded) {
    if (decoded === 'BM_DeployFailed') {
        return ('【BM_DeployFailed】CREATE 失败（create 返回 0），通常为：① 卡 constructor 内 revert（如 gateway 无 code → UC_GlobalMisconfigured）；② gas 不足。' +
            '请确认 initCode 中 gateway 为当前 Factory 地址且该地址在 Base 上有 code，并确认 x402sdk 使用的 BeamioUserCardArtifact 与链上预期一致。\n');
    }
    const stepMatch = decoded?.match(/^BM_DeployFailedAtStep\((\d+)\)$/);
    if (stepMatch) {
        const step = parseInt(stepMatch[1], 10);
        const stepDesc = [
            '0=CREATE 失败（OOG / EIP-170 / EIP-3860 / constructor revert）',
            '1=gateway 不匹配',
            '2=owner 不匹配',
            '3=currency 不匹配',
            '4=price 不匹配',
        ][step] ?? `step=${step}`;
        return `【BM_DeployFailedAtStep】${stepDesc}。若 step=0 请查 gas、runtime/initcode 大小、constructor 参数（gateway 有 code、initialOwner 非零）。\n`;
    }
    return '';
}
function isConfiguredLibAddress(s) {
    return typeof s === 'string' && s.startsWith('0x') && s.length === 42;
}
/** EIP-55 or all-lowercase hex; if checksum fails, retry with lowercase (constants/env typos). */
function tryNormalizeLibAddress(s) {
    if (!s?.trim())
        return undefined;
    const t = s.trim();
    try {
        return ethers_1.ethers.getAddress(t);
    }
    catch {
        try {
            return ethers_1.ethers.getAddress(t.toLowerCase());
        }
        catch {
            return undefined;
        }
    }
}
/**
 * 解析 BeamioUserCard 链接库地址：显式 override → 环境变量 → chainAddresses 常量。
 * SI / Master 可不传 libraryAddresses，只要已发布版本的 chainAddresses 或进程 env 已配置。
 */
/** 与 Master 失败笔对齐：gas 上限需覆盖 ~25KB initCode 的 CREATE；可用 BEAMIO_CREATE_CARD_GAS_LIMIT 覆盖 */
const DEFAULT_CREATE_CARD_GAS_LIMIT = 8500000n;
/** Factory appendTierForCard after create; available via BEAMIO_APPEND_TIER_GAS_LIMIT */
const DEFAULT_APPEND_TIER_GAS_LIMIT = 1000000n;
function getCreateCardGasLimit() {
    const raw = typeof process !== 'undefined' ? process.env?.BEAMIO_CREATE_CARD_GAS_LIMIT?.trim() : undefined;
    if (raw && /^\d+$/.test(raw))
        return BigInt(raw);
    return DEFAULT_CREATE_CARD_GAS_LIMIT;
}
function getAppendTierForCardGasLimit() {
    const raw = typeof process !== 'undefined' ? process.env?.BEAMIO_APPEND_TIER_GAS_LIMIT?.trim() : undefined;
    if (raw && /^\d+$/.test(raw))
        return BigInt(raw);
    return DEFAULT_APPEND_TIER_GAS_LIMIT;
}
function resolveBeamioUserCardLibraryAddresses(override) {
    const defaults = {
        BeamioUserCardAdminGatewayLib: chainAddresses_1.BASE_BEAMIO_USER_CARD_ADMIN_GATEWAY_LIB,
        BeamioUserCardFaucetGatewayLib: chainAddresses_1.BASE_BEAMIO_USER_CARD_FAUCET_GATEWAY_LIB,
        BeamioUserCardFormattingLib: chainAddresses_1.BASE_BEAMIO_USER_CARD_FORMATTING_LIB,
        BeamioUserCardGatewayMintLib: chainAddresses_1.BASE_BEAMIO_USER_CARD_GATEWAY_MINT_LIB,
        BeamioUserCardGovernanceLib: chainAddresses_1.BASE_BEAMIO_USER_CARD_GOVERNANCE_LIB,
        BeamioUserCardIssuedNftGatewayLib: chainAddresses_1.BASE_BEAMIO_USER_CARD_ISSUED_NFT_GATEWAY_LIB,
        BeamioUserCardModuleRouterLib: chainAddresses_1.BASE_BEAMIO_USER_CARD_MODULE_ROUTER_LIB,
        BeamioUserCardRedeemGatewayLib: chainAddresses_1.BASE_BEAMIO_USER_CARD_REDEEM_GATEWAY_LIB,
        BeamioUserCardReferrerLib: chainAddresses_1.BASE_BEAMIO_USER_CARD_REFERRER_LIB,
        BeamioUserCardTransferLib: chainAddresses_1.BASE_BEAMIO_USER_CARD_TRANSFER_LIB,
        BeamioUserCardUpdateLib: chainAddresses_1.BASE_BEAMIO_USER_CARD_UPDATE_LIB,
        BeamioUserCardViewsLib: chainAddresses_1.BASE_BEAMIO_USER_CARD_VIEWS_LIB,
        BeamioUserCardMembershipGateLib: chainAddresses_1.BASE_BEAMIO_USER_CARD_MEMBERSHIP_GATE_LIB,
    };
    const out = {};
    for (const libName of Object.keys(defaults)) {
        const envName = `BEAMIO_USER_CARD_${libName.replace(/^BeamioUserCard/, '').replace(/Lib$/, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}_LIB`;
        const raw = override?.[libName]?.trim() ||
            (typeof process !== 'undefined' ? process.env?.[envName]?.trim() : undefined) ||
            defaults[libName];
        const normalized = isConfiguredLibAddress(raw) ? tryNormalizeLibAddress(raw) : undefined;
        if (!normalized)
            return undefined;
        out[libName] = normalized;
    }
    return out;
}
/** EIP-170 runtime bytecode limit (24 KiB). */
exports.BEAMIO_USER_CARD_EIP170_MAX_BYTES = 24576;
/** Fail fast when linked deployed bytecode would exceed EIP-170 (BM_DeployFailedAtStep(0)). */
function assertBeamioUserCardLinkedDeployedBytecodeFitsEip170(libraryAddresses) {
    const artifact = BeamioUserCardArtifact_json_1.default;
    if (!artifact?.deployedBytecode) {
        throw new Error('BeamioUserCard artifact missing deployedBytecode');
    }
    let deployed = artifact.deployedBytecode;
    const lr = artifact.linkReferences;
    if (lr && Object.keys(lr).length > 0) {
        const libs = resolveBeamioUserCardLibraryAddresses(libraryAddresses);
        if (!libs) {
            throw new Error('BeamioUserCard library addresses incomplete (including BeamioUserCardMembershipGateLib). ' +
                'Run ensureConetUserCardLibraries and sync chainAddresses.ts.');
        }
        deployed = (0, linkBeamioUserCardBytecode_js_1.linkBeamioUserCardBytecode)(deployed, lr, libs);
    }
    const bytes = (deployed.length - 2) / 2;
    if (bytes > exports.BEAMIO_USER_CARD_EIP170_MAX_BYTES) {
        throw new Error(`BeamioUserCard deployed bytecode ${bytes} bytes exceeds EIP-170 limit ${exports.BEAMIO_USER_CARD_EIP170_MAX_BYTES} ` +
            `(createCard would fail with BM_DeployFailedAtStep(0)). Recompile with Scheme C/A/B size reductions.`);
    }
}
/**
 * 为用户创建 BeamioUserCard（CCSA 卡），并返回新卡的合约地址。
 * 调用者需为工厂的 paymaster；initCode 需由 buildBeamioUserCardInitCode 或 Hardhat 脚本生成。
 */
async function createBeamioCard(signer, cardOwner, currency, pointsUnitPriceInCurrencyE6, options) {
    if (!ethers_1.ethers.isAddress(cardOwner))
        throw new Error('Invalid cardOwner address');
    const currencyEnum = CURRENCY_TO_ENUM[currency];
    if (currencyEnum === undefined)
        throw new Error(`Unsupported currency: ${currency}`);
    const priceE6 = BigInt(pointsUnitPriceInCurrencyE6);
    if (priceE6 <= 0n)
        throw new Error('pointsUnitPriceInCurrencyE6 must be > 0');
    const factoryAddress = options.factoryAddress ?? chainAddresses_1.BASE_CARD_FACTORY;
    const initCode = options.initCode;
    if (!initCode || typeof initCode !== 'string' || !initCode.startsWith('0x')) {
        throw new Error('options.initCode is required (hex string, e.g. from buildBeamioUserCardInitCode)');
    }
    const factory = new ethers_1.ethers.Contract(factoryAddress, BeamioFactoryPaymasterABI, signer);
    const tx = await factory.createCardCollectionWithInitCode(cardOwner, currencyEnum, priceE6, initCode, { gasLimit: 6_000_000 });
    const receipt = await tx.wait();
    if (!receipt)
        throw new Error('Transaction failed');
    // 从 CardDeployed 事件解析新卡地址
    let cardAddress;
    try {
        const iface = factory.interface;
        const log = receipt.logs?.find((l) => {
            try {
                const parsed = iface.parseLog({ topics: l.topics, data: l.data });
                return parsed?.name === 'CardDeployed';
            }
            catch {
                return false;
            }
        });
        if (log) {
            const parsed = factory.interface.parseLog({ topics: log.topics, data: log.data });
            cardAddress = parsed?.args?.card ?? parsed?.args?.userCard;
        }
    }
    catch { }
    if (!cardAddress) {
        const cardsOfOwner = await factory.cardsOfOwner(cardOwner);
        if (cardsOfOwner && Array.isArray(cardsOfOwner) && cardsOfOwner.length > 0) {
            cardAddress = cardsOfOwner[cardsOfOwner.length - 1];
        }
    }
    if (!cardAddress || !ethers_1.ethers.isAddress(cardAddress)) {
        throw new Error('Could not resolve new BeamioUserCard address from receipt');
    }
    return ethers_1.ethers.getAddress(cardAddress);
}
/**
 * 生成 BeamioUserCard 的部署 initCode，供 createBeamioCard 使用。
 * 在 Node 环境中传入 Hardhat 产物的 JSON 路径即可；参数与合约 constructor 一致。
 */
async function buildBeamioUserCardInitCode(artifactPath, uri, currencyEnum, pointsUnitPriceInCurrencyE6, initialOwner, gateway, upgradeType = 0, initialTransferWhitelistEnabled = false, libraryAddresses, contractName = '') {
    const fs = require('fs');
    const raw = fs.readFileSync(artifactPath, 'utf-8');
    const artifact = JSON.parse(raw);
    if (!artifact?.bytecode)
        throw new Error('Artifact missing bytecode');
    let bytecode = artifact.bytecode;
    const lr = artifact.linkReferences;
    if (lr && Object.keys(lr).length > 0) {
        const libs = resolveBeamioUserCardLibraryAddresses(libraryAddresses);
        if (!libs) {
            throw new Error('BeamioUserCard artifact has linkReferences; pass libraryAddresses to buildBeamioUserCardInitCode, ' +
                'or set BEAMIO_USER_CARD_FORMATTING_LIB / BEAMIO_USER_CARD_TRANSFER_LIB, ' +
                'or configure BASE_BEAMIO_USER_CARD_*_LIB in chainAddresses.ts');
        }
        bytecode = (0, linkBeamioUserCardBytecode_js_1.linkBeamioUserCardBytecode)(bytecode, lr, libs);
    }
    const factory = new ethers_1.ethers.ContractFactory(artifact.abi, bytecode);
    // BeamioUserCard constructor is (uri, currency, priceE6, initialOwner, gateway) only.
    void upgradeType;
    void initialTransferWhitelistEnabled;
    void contractName;
    const deployTx = await factory.getDeployTransaction(uri, currencyEnum, pointsUnitPriceInCurrencyE6, initialOwner, gateway);
    const initCode = deployTx?.data;
    if (!initCode)
        throw new Error('Failed to build BeamioUserCard initCode');
    return initCode;
}
/** 内嵌 artifact，无需 fs，根据人类可读参数生成 BeamioUserCard 的 initCode（供 createBeamioCardWithFactory 内部使用或直接调用） */
async function buildBeamioUserCardInitCodeFromParams(uri, currencyEnum, pointsUnitPriceInCurrencyE6, initialOwner, gateway, upgradeType, initialTransferWhitelistEnabled = false, libraryAddresses, contractName = '') {
    const artifact = BeamioUserCardArtifact_json_1.default;
    if (!artifact?.bytecode)
        throw new Error('BeamioUserCard artifact missing bytecode');
    // P2: when the CoNET UpgradeableBeacon is configured, Factory CREATE deploys BeaconProxy
    // (card address stays stable). Until then keep the existing UserCard constructor CREATE path.
    void upgradeType;
    void initialTransferWhitelistEnabled;
    void contractName;
    if ((0, chainAddresses_1.isConetUserCardBeaconConfigured)()) {
        return (0, beamioUserCardBeaconInitCode_1.buildBeamioUserCardBeaconProxyInitCode)({
            uri,
            currencyEnum,
            pointsUnitPriceInCurrencyE6,
            initialOwner,
            gateway,
        });
    }
    let bytecode = artifact.bytecode;
    const lr = artifact.linkReferences;
    if (lr && Object.keys(lr).length > 0) {
        const libs = resolveBeamioUserCardLibraryAddresses(libraryAddresses);
        if (!libs) {
            throw new Error('BeamioUserCard requires linked libraries. Pass libraryAddresses in CreateBeamioCardInitCodeOptions, ' +
                'or set BEAMIO_USER_CARD_FORMATTING_LIB / BEAMIO_USER_CARD_TRANSFER_LIB, ' +
                'or configure BASE_BEAMIO_USER_CARD_*_LIB in chainAddresses.ts (see BeamioContract scripts/beamioUserCardLibraries.ts). ' +
                'Alternatively supply a pre-linked initCode hex string.');
        }
        bytecode = (0, linkBeamioUserCardBytecode_js_1.linkBeamioUserCardBytecode)(bytecode, lr, libs);
        assertBeamioUserCardLinkedDeployedBytecodeFitsEip170(libraryAddresses);
    }
    const factory = new ethers_1.ethers.ContractFactory(artifact.abi, bytecode);
    const deployTx = await factory.getDeployTransaction(uri, currencyEnum, pointsUnitPriceInCurrencyE6, initialOwner, gateway);
    const initCode = deployTx?.data;
    if (!initCode)
        throw new Error('Failed to build BeamioUserCard initCode');
    return initCode;
}
/**
 * 使用已实例化的工厂合约创建 BeamioUserCard，并返回新卡地址。
 * 第五参可为：
 * - 已编码的 initCode 字符串（hex），或
 * - 人类可读的 initCode 选项（uri、gateway），由本函数内部组合生成 initCode；gateway 默认取 factory 地址。
 */
async function createBeamioCardWithFactory(factory, cardOwner, currency, pointsUnitPriceInCurrencyE6, initCodeOrOptions) {
    if (!ethers_1.ethers.isAddress(cardOwner))
        throw new Error('Invalid cardOwner address');
    const currencyEnum = CURRENCY_TO_ENUM[currency];
    if (currencyEnum === undefined)
        throw new Error(`Unsupported currency: ${currency}`);
    const priceE6 = BigInt(pointsUnitPriceInCurrencyE6);
    if (priceE6 <= 0n)
        throw new Error('pointsUnitPriceInCurrencyE6 must be > 0');
    (0, createCardChainTrace_1.emitCreateCardChainTrace)('CCSA.createBeamioCardWithFactory.enter', {
        cardOwner,
        currency,
        priceE6: priceE6.toString(),
    });
    let initCode;
    let initCodeSource;
    let gatewayUsedWhenBuilding;
    let libraryOverrideForDebug;
    if (typeof initCodeOrOptions === 'string') {
        if (!initCodeOrOptions || !initCodeOrOptions.startsWith('0x')) {
            throw new Error('initCode must be a hex string (e.g. 0x...) when passed as string');
        }
        initCode = initCodeOrOptions;
        initCodeSource = 'prebuiltHex';
    }
    else {
        const resolvedFactory = await resolveFactoryAddressForInitCode(factory);
        const requestedGw = initCodeOrOptions.gateway;
        if (requestedGw !== undefined && ethers_1.ethers.getAddress(requestedGw) !== resolvedFactory) {
            console.warn(`[CCSA] initCodeOptions.gateway (${ethers_1.ethers.getAddress(requestedGw)}) ignored; using factory ${resolvedFactory} ` +
                '(BeamioUserCard.factoryGateway() must equal the factory that calls createCardCollectionWithInitCode).');
        }
        const gateway = resolvedFactory;
        gatewayUsedWhenBuilding = gateway;
        libraryOverrideForDebug = initCodeOrOptions.libraryAddresses;
        const uri = initCodeOrOptions.uri ?? BEAMIO_METADATA_BASE_URI;
        const wlOn = initCodeOrOptions.transferWhitelistEnabled === true;
        const ut = initCodeOrOptions.upgradeType;
        const upgradeType = ut === 1 || ut === 2 ? ut : 0;
        initCode = await buildBeamioUserCardInitCodeFromParams(uri, currencyEnum, priceE6, cardOwner, gateway, upgradeType, wlOn, initCodeOrOptions.libraryAddresses, initCodeOrOptions.contractName?.trim() ?? '');
        initCodeSource = 'builtFromOptions';
    }
    // 调用 createCardCollectionWithInitCode 前确认 factory 的 signer 是工厂 owner（或已注册 paymaster）
    const runner = factory.runner;
    if (!runner || typeof runner.getAddress !== 'function') {
        throw new Error('Factory contract has no signer (runner). Cannot determine caller.');
    }
    const signerAddress = await runner.getAddress();
    const factoryOwner = (await factory.owner());
    const isPaymaster = typeof factory.isPaymaster === 'function' ? await factory.isPaymaster(signerAddress) : false;
    const isOwner = signerAddress.toLowerCase() === factoryOwner.toLowerCase();
    if (!isOwner && !isPaymaster) {
        throw new Error(`Factory signer (${signerAddress}) is not the factory owner (${factoryOwner}) nor a registered paymaster. ` +
            'Only owner or paymaster can call createCardCollectionWithInitCode.');
    }
    const gasLimit = getCreateCardGasLimit();
    // 预检查：工厂使用的 deployer 必须已通过 setFactory(factory) 指向当前工厂，否则 deploy() 会 revert（DEP_NotFactory）
    const deployerAddr = (await factory.deployer());
    if (deployerAddr && ethers_1.ethers.getAddress(deployerAddr) !== ethers_1.ethers.ZeroAddress) {
        const deployerContract = new ethers_1.ethers.Contract(deployerAddr, ['function factory() view returns (address)'], factory.runner);
        try {
            const deployerFactory = (await deployerContract.factory());
            const thisFactoryAddr = await factory.getAddress();
            if (deployerFactory.toLowerCase() !== thisFactoryAddr.toLowerCase()) {
                throw new Error(`Factory 使用的 Deployer (${deployerAddr}) 未指向当前工厂 (${thisFactoryAddr})。` +
                    '请由 Deployer 的 owner 调用 setFactory(工厂地址) 后再发卡。');
            }
        }
        catch (e) {
            if (e instanceof Error && e.message.includes('未指向当前工厂'))
                throw e;
            // deployer 无 factory() 或调用失败时忽略，交给后续链上调用失败时的统一提示
        }
    }
    const createCardDebugSnap = await collectCreateCardChainDebugSnapshot(factory, initCode, {
        cardOwner,
        currencyEnum,
        priceE6,
        signerAddress,
        gasLimit,
        callKind: 'createCardCollectionWithInitCode',
        initCodeSource,
        gatewayUsedWhenBuilding,
        libraryOverride: libraryOverrideForDebug,
        rawTierCount: 0,
        normalizedTierCount: 0,
    });
    if (isVerboseCreateCardDebug())
        emitCreateCardDebug('preflight', createCardDebugSnap);
    (0, createCardChainTrace_1.emitCreateCardChainTrace)('CCSA.createBeamioCardWithFactory.beforeSendTx', {
        callKind: createCardDebugSnap.callKind,
        factoryAddress: createCardDebugSnap.factoryAddress,
        signerAddress: createCardDebugSnap.signerAddress,
        initCodeKeccak256: createCardDebugSnap.initCodeKeccak256,
        initCodeByteLength: createCardDebugSnap.initCodeByteLength,
    });
    let tx;
    let receipt = null;
    try {
        tx = await factory.createCardCollectionWithInitCode(cardOwner, currencyEnum, priceE6, initCode, { gasLimit: gasLimit });
        receipt = await tx.wait();
        if (!receipt)
            throw new Error('Transaction failed');
        // Revert is often surfaced here (after mining), not on the initial send — keep in same try/catch as send.
        if (Number(receipt.status) === 0) {
            throw Object.assign(new Error('transaction execution reverted'), {
                code: 'CALL_EXCEPTION',
                shortMessage: 'transaction execution reverted',
                receipt,
            });
        }
    }
    catch (e) {
        const err = e;
        const revertData = err?.data ??
            e.data ??
            e.info?.error?.data;
        const decoded = parseCreateCardRevertData(revertData);
        const failSnap = {
            ...createCardDebugSnap,
            failureRpcCode: err?.code ?? null,
            failureShortMessage: err?.shortMessage ?? err?.message ?? String(e),
            parsedRevert: decoded ?? null,
        };
        (0, createCardChainTrace_1.emitCreateCardChainTrace)('CCSA.createBeamioCardWithFactory.sendFailed', {
            failureRpcCode: failSnap.failureRpcCode,
            parsedRevert: failSnap.parsedRevert,
            initCodeKeccak256: failSnap.initCodeKeccak256,
        });
        emitCreateCardDebug('failure', failSnap);
        const isCallException = err?.code === 'CALL_EXCEPTION';
        const noUsefulReason = !decoded && (err?.shortMessage === 'missing revert data' || !err?.reason || (err?.message && err.message.includes('unknown custom error')));
        if (isCallException && (noUsefulReason || decoded)) {
            const reasonLine = decoded ? `链上 revert: ${decoded}` : 'RPC 未返回具体原因';
            const dataStr = revertData != null ? (typeof revertData === 'string' ? revertData : ethers_1.ethers.hexlify(revertData)) : '';
            const hint = createCardRevertHint(decoded);
            throw new Error(appendSnapshotToErrorMessage(`createCardCollectionWithInitCode 链上执行 revert（${reasonLine}）。常见原因：\n` +
                '  1) Deployer 未配置：工厂使用的 Deployer 合约需由其 owner 调用 setFactory(工厂地址)。运行 npm run check:createcard-deployer:base 诊断，修复：npm run set:card-deployer-factory:base\n' +
                '  2) 新卡 constructor revert：例如 gateway 地址无 code（UC_GlobalMisconfigured）；\n' +
                '  3) 工厂校验失败：部署后 factoryGateway/owner/currency/price 与传入不一致（BM_DeployFailedAtStep 2–4）；\n' +
                '  4) 本 helper 只发 createCardCollectionWithInitCode。带 loyalty 档须走 ReturningHash 一笔 3-tuple AndTiers（0x9a7eb0f0）；禁止 artifact 4-tuple 0x62cb913c；禁止先 create 再 append。\n' +
                (hint ? hint : '') +
                (dataStr ? `原始 data（前 74 字符）: ${dataStr.slice(0, 74)}${dataStr.length > 74 ? '...' : ''}\n` : '') +
                (dataStr ? `rawRevertDataForRpc=${dataStr}\n` : '') +
                `原始错误: ${err?.shortMessage ?? err?.message ?? String(e)}`, failSnap));
        }
        throw new Error(appendSnapshotToErrorMessage(err?.shortMessage ?? err?.message ?? String(e), failSnap));
    }
    let cardAddress;
    try {
        const iface = factory.interface;
        const log = receipt.logs?.find((l) => {
            try {
                const parsed = iface.parseLog({ topics: l.topics, data: l.data });
                return parsed?.name === 'CardDeployed';
            }
            catch {
                return false;
            }
        });
        if (log) {
            const parsed = factory.interface.parseLog({ topics: log.topics, data: log.data });
            cardAddress = parsed?.args?.card ?? parsed?.args?.userCard;
        }
    }
    catch { }
    if (!cardAddress) {
        const cardsOfOwner = await factory.cardsOfOwner(cardOwner);
        if (cardsOfOwner && Array.isArray(cardsOfOwner) && cardsOfOwner.length > 0) {
            cardAddress = cardsOfOwner[cardsOfOwner.length - 1];
        }
    }
    if (!cardAddress || !ethers_1.ethers.isAddress(cardAddress)) {
        throw new Error('Could not resolve new BeamioUserCard address from receipt');
    }
    const out = ethers_1.ethers.getAddress(cardAddress);
    (0, createCardChainTrace_1.emitCreateCardChainTrace)('CCSA.createBeamioCardWithFactory.success', {
        cardAddress: out,
        txHash: tx.hash,
    });
    return out;
}
function resolveCreateCardTierUpgradeByBalance(tier, cardUpgradeType) {
    if (cardUpgradeType === 0 || cardUpgradeType === 1 || cardUpgradeType === 2) {
        return cardUpgradeType === 1;
    }
    return Boolean(tier.upgradeByBalance);
}
function normalizeTiersForCreateCard(tiers, cardUpgradeType) {
    if (!tiers?.length)
        return [];
    const out = [];
    for (const t of tiers) {
        const min = BigInt(t.minUsdc6);
        if (min <= 0n)
            continue;
        out.push({
            minUsdc6: min,
            attr: BigInt(t.attr),
            tierExpirySeconds: BigInt(t.tierExpirySeconds ?? 0),
            upgradeByBalance: resolveCreateCardTierUpgradeByBalance(t, cardUpgradeType),
        });
    }
    return out;
}
/**
 * @deprecated Loyalty eligible rows go in the same AndTiers create tx (including a single base row).
 * Kept for diagnostics; do not use to skip Factory AndTiers.
 */
function isBasicOnlyCreateCardTiers(tiers) {
    return normalizeTiersForCreateCard(tiers).length <= 1;
}
/**
 * Live CoNET Factory AndTiers is 3-tuple (selector 0x9a7eb0f0).
 * Do not call `factory.createCardCollectionWithInitCodeAndTiers` on the Hardhat
 * artifact ABI — that encodes 4-tuple `upgradeByBalance` (0x62cb913c) and throws
 * `missing value for component upgradeByBalance` before RPC.
 */
const CONET_FACTORY_AND_TIERS_IFACE = new ethers_1.ethers.Interface([
    'function createCardCollectionWithInitCodeAndTiers(address cardOwner,uint8 currency,uint256 priceInCurrencyE6,bytes initCode,(uint256 minUsdc6,uint256 attr,uint256 tierExpirySeconds)[] tiers) returns (address card)',
]);
function encodeCreateCardCollectionWithInitCodeAndTiersCalldata(cardOwner, currencyEnum, priceE6, initCode, tiers) {
    const data = CONET_FACTORY_AND_TIERS_IFACE.encodeFunctionData('createCardCollectionWithInitCodeAndTiers', [
        cardOwner,
        currencyEnum,
        priceE6,
        initCode,
        tiers.map((t) => ({
            minUsdc6: t.minUsdc6,
            attr: t.attr,
            tierExpirySeconds: t.tierExpirySeconds,
        })),
    ]);
    const sel = data.slice(0, 10).toLowerCase();
    if (sel !== chainAddresses_1.FACTORY_CREATE_CARD_COLLECTION_WITH_INIT_CODE_AND_TIERS_SELECTOR) {
        throw new Error(`AndTiers calldata selector ${sel} is not CoNET 3-tuple ${chainAddresses_1.FACTORY_CREATE_CARD_COLLECTION_WITH_INIT_CODE_AND_TIERS_SELECTOR}. ` +
            `Do not encode upgradeByBalance (4-tuple ${chainAddresses_1.FACTORY_CREATE_CARD_COLLECTION_WITH_INIT_CODE_AND_TIERS_4TUPLE_SELECTOR}).`);
    }
    return data;
}
/** Live CoNET Factory: one tx create + 3-tuple tiers (selector 0x9a7eb0f0). */
async function sendCreateCardCollectionWithInitCodeAndTiers(factory, cardOwner, currencyEnum, priceE6, initCode, tiers, gasLimit) {
    const signer = factory.runner;
    if (!signer || typeof signer.sendTransaction !== 'function') {
        throw new Error('Factory contract has no signer. Cannot send AndTiers createCard.');
    }
    const data = encodeCreateCardCollectionWithInitCodeAndTiersCalldata(cardOwner, currencyEnum, priceE6, initCode, tiers);
    return signer.sendTransaction({
        to: await resolveFactoryAddressForInitCode(factory),
        data,
        gasLimit,
    });
}
async function resolveFactoryAddressForInitCode(factory) {
    if (typeof factory.getAddress === 'function') {
        return ethers_1.ethers.getAddress(await factory.getAddress());
    }
    const a = factory.address;
    if (!a)
        throw new Error('Factory contract has no getAddress() nor address');
    return ethers_1.ethers.getAddress(a);
}
const CONET_FACTORY_APPEND_TIER_IFACE = new ethers_1.ethers.Interface([
    'function appendTierForCard(address cardAddr, uint256 minUsdc6, uint256 attr, uint256 tierExpirySeconds, bool upgradeByBalance)',
]);
function encodeAppendTierForCardCalldata(cardAddr, minUsdc6, attr, tierExpirySeconds, upgradeByBalance) {
    const data = CONET_FACTORY_APPEND_TIER_IFACE.encodeFunctionData('appendTierForCard', [
        cardAddr,
        minUsdc6,
        attr,
        tierExpirySeconds,
        upgradeByBalance,
    ]);
    const sel = data.slice(0, 10).toLowerCase();
    if (sel === chainAddresses_1.FACTORY_CREATE_CARD_COLLECTION_WITH_INIT_CODE_AND_TIERS_SELECTOR ||
        sel === chainAddresses_1.FACTORY_CREATE_CARD_COLLECTION_WITH_INIT_CODE_AND_TIERS_4TUPLE_SELECTOR) {
        throw new Error(`appendTierForCard calldata selector ${sel} collided with AndTiers. ` +
            `Do not send ${chainAddresses_1.FACTORY_CREATE_CARD_COLLECTION_WITH_INIT_CODE_AND_TIERS_SELECTOR} or ` +
            `${chainAddresses_1.FACTORY_CREATE_CARD_COLLECTION_WITH_INIT_CODE_AND_TIERS_4TUPLE_SELECTOR}.`);
    }
    return data;
}
/** Recover / orphan only. New-card path must use AndTiers, not this. */
async function sendAppendTierForCard(factory, cardAddr, tier) {
    const signer = factory.runner;
    if (!signer || typeof signer.sendTransaction !== 'function') {
        throw new Error('Factory contract has no signer. Cannot send appendTierForCard.');
    }
    const data = encodeAppendTierForCardCalldata(cardAddr, tier.minUsdc6, tier.attr, tier.tierExpirySeconds, tier.upgradeByBalance);
    const tx = await signer.sendTransaction({
        to: await resolveFactoryAddressForInitCode(factory),
        data,
        gasLimit: getAppendTierForCardGasLimit(),
    });
    const receipt = await tx.wait();
    if (!receipt)
        throw new Error('appendTierForCard: missing receipt');
    if (Number(receipt.status) === 0) {
        throw new Error(`appendTierForCard reverted (tx=${tx.hash})`);
    }
    return receipt;
}
function isVerboseCreateCardDebug() {
    return typeof process !== 'undefined' && process.env?.BEAMIO_CREATE_CARD_DEBUG === '1';
}
/**
 * Collect on-chain + initCode fingerprints to compare local Hardhat vs server Master.
 * Set BEAMIO_CREATE_CARD_DEBUG=1 to also log a verbose block before send (see emitCreateCardDebug).
 */
async function collectCreateCardChainDebugSnapshot(factory, initCode, params) {
    const factoryAddr = await resolveFactoryAddressForInitCode(factory);
    const ic = initCode.startsWith('0x') ? initCode : `0x${initCode}`;
    const initCodeByteLength = (ic.length - 2) / 2;
    const initCodeKeccak256 = ethers_1.ethers.keccak256(ic);
    const libs = resolveBeamioUserCardLibraryAddresses(params.libraryOverride);
    let chainId = null;
    try {
        const p = factory.runner && 'provider' in factory.runner ? factory.runner.provider : null;
        if (p)
            chainId = (await p.getNetwork()).chainId.toString();
    }
    catch {
        chainId = null;
    }
    let deployerAddress = null;
    let deployerFactory = null;
    let deployerFactoryMatches = null;
    try {
        deployerAddress = (await factory.deployer());
        if (deployerAddress && ethers_1.ethers.getAddress(deployerAddress) !== ethers_1.ethers.ZeroAddress) {
            const dc = new ethers_1.ethers.Contract(deployerAddress, ['function factory() view returns (address)'], factory.runner);
            deployerFactory = (await dc.factory());
            deployerFactoryMatches =
                deployerFactory.toLowerCase() === factoryAddr.toLowerCase();
        }
    }
    catch {
        deployerAddress = deployerAddress ?? null;
    }
    const gw = params.gatewayUsedWhenBuilding;
    const gatewayMatchesFactory = gw !== undefined ? gw.toLowerCase() === factoryAddr.toLowerCase() : null;
    return {
        chainId: chainId ?? 'unknown',
        factoryAddress: factoryAddr,
        signerAddress: params.signerAddress,
        cardOwner: params.cardOwner,
        currencyEnum: params.currencyEnum,
        priceE6: params.priceE6.toString(),
        callKind: params.callKind,
        gasLimit: params.gasLimit.toString(),
        initCodeSource: params.initCodeSource,
        initCodeByteLength,
        initCodeKeccak256,
        initCodePrefixHex: ic.slice(0, 26),
        gatewayUsedWhenBuilding: gw ?? null,
        gatewayMatchesFactory: gatewayMatchesFactory ?? null,
        beamioUserCardFormattingLib: libs?.BeamioUserCardFormattingLib ?? 'missing',
        beamioUserCardTransferLib: libs?.BeamioUserCardTransferLib ?? 'missing',
        deployerAddress,
        deployerFactory,
        deployerFactoryMatches,
        rawTierCount: params.rawTierCount ?? 0,
        normalizedTierCount: params.normalizedTierCount ?? 0,
        noteGatewayRule: 'BeamioUserCard.factoryGateway() must equal the factory that calls createCard; initCode gateway must match factory address.',
        noteReceiptLogs: 'On revert, tx receipt logs are usually empty; use debug_traceTransaction / Tenderly for inner revert.',
        noteCompareLocal: 'Compare initCodeKeccak256 with a local Hardhat create (same owner/currency/price/gateway). If hashes differ, artifact or library link addresses differ (run compile + syncBeamioUserCardToX402sdk).',
        noteStep0vs1: 'BM_DeployFailedAtStep(0)=CREATE/constructor; step(1)=gateway mismatch; steps 2–4=owner/currency/price.',
    };
}
function emitCreateCardDebug(phase, snapshot) {
    const line = `[BeamioCreateCard:${phase}] ${JSON.stringify(snapshot)}`;
    console.warn(line);
    if (phase === 'preflight' && isVerboseCreateCardDebug()) {
        console.warn('[BeamioCreateCard:preflight:verbose] BEAMIO_CREATE_CARD_DEBUG=1 is set; unset after diagnosis to reduce log volume.');
    }
}
function appendSnapshotToErrorMessage(base, snapshot) {
    try {
        return `${base}\n[createCardDebugJson] ${JSON.stringify(snapshot)}`;
    }
    catch {
        return base;
    }
}
/** Same as createBeamioCardWithFactory, plus `{ cardAddress, hash }`.
 * Loyalty (top-up / charge / balance): one tx `createCardCollectionWithInitCodeAndTiers`
 * (live 3-tuple, selector 0x9a7eb0f0). Membership-fee / no valid tiers: initCode-only create.
 * Do not create then `appendTierForCard` on the new-card path (orphan if append reverts).
 * Keep `sendAppendTierForCard` for recover only. */
async function createBeamioCardWithFactoryReturningHash(factory, cardOwner, currency, pointsUnitPriceInCurrencyE6, initCodeOrOptions, tiers) {
    if (!ethers_1.ethers.isAddress(cardOwner))
        throw new Error('Invalid cardOwner address');
    const currencyEnum = CURRENCY_TO_ENUM[currency];
    if (currencyEnum === undefined)
        throw new Error(`Unsupported currency: ${currency}`);
    const priceE6 = BigInt(pointsUnitPriceInCurrencyE6);
    if (priceE6 <= 0n)
        throw new Error('pointsUnitPriceInCurrencyE6 must be > 0');
    (0, createCardChainTrace_1.emitCreateCardChainTrace)('CCSA.createBeamioCardWithFactoryReturningHash.enter', {
        cardOwner,
        currency,
        priceE6: priceE6.toString(),
        tierArgLength: tiers?.length ?? 0,
    });
    let initCode;
    let initCodeSource;
    let gatewayUsedWhenBuilding;
    let libraryOverrideForDebug;
    if (typeof initCodeOrOptions === 'string') {
        if (!initCodeOrOptions || !initCodeOrOptions.startsWith('0x')) {
            throw new Error('initCode must be a hex string (e.g. 0x...) when passed as string');
        }
        initCode = initCodeOrOptions;
        initCodeSource = 'prebuiltHex';
    }
    else {
        const resolvedFactory = await resolveFactoryAddressForInitCode(factory);
        const requestedGw = initCodeOrOptions.gateway;
        if (requestedGw !== undefined && ethers_1.ethers.getAddress(requestedGw) !== resolvedFactory) {
            console.warn(`[CCSA] initCodeOptions.gateway (${ethers_1.ethers.getAddress(requestedGw)}) ignored; using factory ${resolvedFactory} ` +
                '(BeamioUserCard.factoryGateway() must equal the factory that calls createCardCollectionWithInitCode).');
        }
        const gateway = resolvedFactory;
        gatewayUsedWhenBuilding = gateway;
        libraryOverrideForDebug = initCodeOrOptions.libraryAddresses;
        const uri = initCodeOrOptions.uri ?? BEAMIO_METADATA_BASE_URI;
        const wlOn = initCodeOrOptions.transferWhitelistEnabled === true;
        const ut2 = initCodeOrOptions.upgradeType;
        const upgradeType2 = ut2 === 1 || ut2 === 2 ? ut2 : 0;
        initCode = await buildBeamioUserCardInitCodeFromParams(uri, currencyEnum, priceE6, cardOwner, gateway, upgradeType2, wlOn, initCodeOrOptions.libraryAddresses, initCodeOrOptions.contractName?.trim() ?? '');
        initCodeSource = 'builtFromOptions';
    }
    const runner = factory.runner;
    if (!runner || typeof runner.getAddress !== 'function') {
        throw new Error('Factory contract has no signer (runner). Cannot determine caller.');
    }
    const signerAddress = await runner.getAddress();
    const factoryOwner = (await factory.owner());
    const isPaymaster = typeof factory.isPaymaster === 'function' ? await factory.isPaymaster(signerAddress) : false;
    const isOwner = signerAddress.toLowerCase() === factoryOwner.toLowerCase();
    if (!isOwner && !isPaymaster) {
        throw new Error(`Factory signer (${signerAddress}) is not the factory owner (${factoryOwner}) nor a registered paymaster. ` +
            'Only owner or paymaster can call createCardCollectionWithInitCode.');
    }
    const deployerAddr = (await factory.deployer());
    if (deployerAddr && ethers_1.ethers.getAddress(deployerAddr) !== ethers_1.ethers.ZeroAddress) {
        const deployerContract = new ethers_1.ethers.Contract(deployerAddr, ['function factory() view returns (address)'], factory.runner);
        try {
            const deployerFactory = (await deployerContract.factory());
            const thisFactoryAddr = await factory.getAddress();
            if (deployerFactory.toLowerCase() !== thisFactoryAddr.toLowerCase()) {
                throw new Error(`Factory 使用的 Deployer (${deployerAddr}) 未指向当前工厂 (${thisFactoryAddr})。` +
                    '请由 Deployer 的 owner 调用 setFactory(工厂地址) 后再发卡。');
            }
        }
        catch (e) {
            if (e instanceof Error && e.message.includes('未指向当前工厂'))
                throw e;
        }
    }
    const skipMembershipTiers = (0, membershipFeeMetadata_1.shouldSkipFactoryTiersForCreate)(tiers);
    const cardUpgradeType = typeof initCodeOrOptions === 'object'
        ? initCodeOrOptions.upgradeType === 1 || initCodeOrOptions.upgradeType === 2
            ? initCodeOrOptions.upgradeType
            : 0
        : undefined;
    const tiersToAppend = skipMembershipTiers ? [] : normalizeTiersForCreateCard(tiers, cardUpgradeType);
    (0, createCardTiersDebug_1.emitCreateCardTiersJson)('CCSA.createBeamioCardWithFactoryReturningHash.normalizedTiersForChain', tiersToAppend.map((t) => ({
        minUsdc6: t.minUsdc6.toString(),
        attr: t.attr.toString(),
        tierExpirySeconds: t.tierExpirySeconds.toString(),
        upgradeByBalance: t.upgradeByBalance,
    })));
    if (skipMembershipTiers) {
        console.warn('[CCSA] createCard metadata declares membership fees; using createCardCollectionWithInitCode (no Factory tiers).');
    }
    else if (tiers?.length && tiersToAppend.length === 0) {
        console.warn('[CCSA] createCard tiers input had only minUsdc6<=0 entries; using createCardCollectionWithInitCode (no AndTiers) to avoid UC_TierMinZero.');
    }
    const gasLimit = getCreateCardGasLimit() +
        (tiersToAppend.length > 0 ? getAppendTierForCardGasLimit() * BigInt(tiersToAppend.length) : 0n);
    const callKind = tiersToAppend.length > 0
        ? 'createCardCollectionWithInitCodeAndTiers'
        : 'createCardCollectionWithInitCode';
    const createCardDebugSnap = await collectCreateCardChainDebugSnapshot(factory, initCode, {
        cardOwner,
        currencyEnum,
        priceE6,
        signerAddress,
        gasLimit,
        callKind,
        initCodeSource,
        gatewayUsedWhenBuilding,
        libraryOverride: libraryOverrideForDebug,
        rawTierCount: tiers?.length ?? 0,
        normalizedTierCount: tiersToAppend.length,
    });
    if (isVerboseCreateCardDebug())
        emitCreateCardDebug('preflight', createCardDebugSnap);
    (0, createCardChainTrace_1.emitCreateCardChainTrace)('CCSA.createBeamioCardWithFactoryReturningHash.beforeSendTx', {
        callKind: createCardDebugSnap.callKind,
        factoryAddress: createCardDebugSnap.factoryAddress,
        signerAddress: createCardDebugSnap.signerAddress,
        initCodeKeccak256: createCardDebugSnap.initCodeKeccak256,
        initCodeByteLength: createCardDebugSnap.initCodeByteLength,
        normalizedTierCount: tiersToAppend.length,
    });
    let tx;
    let receipt = null;
    try {
        if (tiersToAppend.length > 0) {
            tx = await sendCreateCardCollectionWithInitCodeAndTiers(factory, cardOwner, currencyEnum, priceE6, initCode, tiersToAppend, gasLimit);
        }
        else {
            tx = await factory.createCardCollectionWithInitCode(cardOwner, currencyEnum, priceE6, initCode, { gasLimit });
        }
        receipt = await tx.wait();
        if (!receipt)
            throw new Error('Transaction failed');
        if (Number(receipt.status) === 0) {
            throw Object.assign(new Error('transaction execution reverted'), {
                code: 'CALL_EXCEPTION',
                shortMessage: 'transaction execution reverted',
                receipt,
            });
        }
    }
    catch (e) {
        const err = e;
        const revertData = err?.data ??
            e.data ??
            e.info?.error?.data;
        const decoded = parseCreateCardRevertData(revertData);
        const failSnap = {
            ...createCardDebugSnap,
            failureRpcCode: err?.code ?? null,
            failureShortMessage: err?.shortMessage ?? err?.message ?? String(e),
            parsedRevert: decoded ?? null,
        };
        (0, createCardChainTrace_1.emitCreateCardChainTrace)('CCSA.createBeamioCardWithFactoryReturningHash.sendFailed', {
            failureRpcCode: failSnap.failureRpcCode,
            parsedRevert: failSnap.parsedRevert,
            initCodeKeccak256: failSnap.initCodeKeccak256,
        });
        emitCreateCardDebug('failure', failSnap);
        const isCallException = err?.code === 'CALL_EXCEPTION';
        const noUsefulReason = !decoded && (err?.shortMessage === 'missing revert data' || !err?.reason || (err?.message && err.message.includes('unknown custom error')));
        if (isCallException && (noUsefulReason || decoded)) {
            const reasonLine = decoded ? `链上 revert: ${decoded}` : 'RPC 未返回具体原因';
            const dataStr = revertData != null ? (typeof revertData === 'string' ? revertData : ethers_1.ethers.hexlify(revertData)) : '';
            const hint = createCardRevertHint(decoded);
            const callName = tiersToAppend.length > 0
                ? 'createCardCollectionWithInitCodeAndTiers'
                : 'createCardCollectionWithInitCode';
            throw new Error(appendSnapshotToErrorMessage(`${callName} 链上执行 revert（${reasonLine}）。常见原因：\n` +
                '  1) Deployer 未配置：工厂使用的 Deployer 合约需由其 owner 调用 setFactory(工厂地址)。运行 npm run check:createcard-deployer:base 诊断，修复：npm run set:card-deployer-factory:base\n' +
                '  2) 新卡 constructor revert：例如 gateway 地址无 code（UC_GlobalMisconfigured）；\n' +
                '  3) 工厂校验失败：部署后 factoryGateway/owner/currency/price 与传入不一致（BM_DeployFailedAtStep 2–4）；\n' +
                '  4) Loyalty 须一笔 3-tuple AndTiers（0x9a7eb0f0）。禁止 artifact 4-tuple 0x62cb913c；禁止先 create 再 append（会 orphan）。Beacon impl 须含 3 参 appendTier（V18+）。会员费卡只走 initCode-only create。\n' +
                (hint ? hint : '') +
                (dataStr ? `原始 data（前 74 字符）: ${dataStr.slice(0, 74)}${dataStr.length > 74 ? '...' : ''}\n` : '') +
                (dataStr ? `rawRevertDataForRpc=${dataStr}\n` : '') +
                `原始错误: ${err?.shortMessage ?? err?.message ?? String(e)}`, failSnap));
        }
        throw new Error(appendSnapshotToErrorMessage(err?.shortMessage ?? err?.message ?? String(e), failSnap));
    }
    const hash = tx.hash;
    let cardAddress;
    try {
        const iface = factory.interface;
        const log = receipt.logs?.find((l) => {
            try {
                const parsed = iface.parseLog({ topics: l.topics, data: l.data });
                return parsed?.name === 'CardDeployed';
            }
            catch {
                return false;
            }
        });
        if (log) {
            const parsed = factory.interface.parseLog({ topics: log.topics, data: log.data });
            cardAddress = parsed?.args?.card ?? parsed?.args?.userCard;
        }
    }
    catch { }
    if (!cardAddress) {
        const cardsOfOwner = await factory.cardsOfOwner(cardOwner);
        if (cardsOfOwner && Array.isArray(cardsOfOwner) && cardsOfOwner.length > 0) {
            cardAddress = cardsOfOwner[cardsOfOwner.length - 1];
        }
    }
    if (!cardAddress || !ethers_1.ethers.isAddress(cardAddress)) {
        throw new Error('Could not resolve new BeamioUserCard address from receipt');
    }
    const resolved = ethers_1.ethers.getAddress(cardAddress);
    (0, createCardChainTrace_1.emitCreateCardChainTrace)('CCSA.createBeamioCardWithFactoryReturningHash.success', {
        cardAddress: resolved,
        txHash: hash,
        factoryTierCount: tiersToAppend.length,
        callKind,
    });
    return { cardAddress: resolved, hash };
}
