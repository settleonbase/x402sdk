// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./BeamioERC1155Logic.sol";
import "./BeamioCurrency.sol";
import "./Errors.sol";

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

contract BeamioUserCard is ERC1155, Ownable, ReentrancyGuard {
    using BeamioCurrency for *;
    using ECDSA for bytes32;

    // ===== constants =====
    uint256 public constant POINTS_ID = BeamioERC1155Logic.POINTS_ID;
    uint8 public constant POINTS_DECIMALS = BeamioERC1155Logic.POINTS_DECIMALS;
    uint256 private constant POINTS_ONE = 1e6;

    uint256 public constant NFT_START_ID = BeamioERC1155Logic.NFT_START_ID;
    uint256 public constant ISSUED_NFT_START_ID = BeamioERC1155Logic.ISSUED_NFT_START_ID;

    // ===== immutable gateway =====
    address public immutable factoryGateway;

    // ===== pricing currency =====
    BeamioCurrency.CurrencyType public currency;
    uint256 public pointsUnitPriceInCurrencyE18;

    // ===== per-card expiry policy =====
    uint256 public expirySeconds; // 0 = never expire
    event ExpirySecondsUpdated(uint256 oldSecs, uint256 newSecs);

    // ===== redeem module (delegatecall) =====
    address public redeemModule;
    event RedeemModuleUpdated(address indexed oldModule, address indexed newModule);

    // ===== multisig governance =====
    uint256 public threshold;
    mapping(address => bool) public isAdmin;
    address[] public adminList;

    struct Proposal {
        address target;
        uint256 v1;
        uint256 v2;
        uint256 v3;
        bytes4 selector;
        uint256 approvals;
        bool executed;
    }

    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(address => bool)) public isApproved;
    uint256 public proposalCount;

    event ProposalCreated(uint256 indexed id, bytes4 indexed selector, address indexed proposer);
    event ProposalApproved(uint256 indexed id, address indexed admin);
    event ProposalExecuted(uint256 indexed id);

    // ===== whitelist =====
    mapping(address => bool) public transferWhitelist;

    // ===== membership state =====
    mapping(uint256 => uint256) public expiresAt;
    mapping(uint256 => uint256) public attributes;
    mapping(uint256 => uint256) public tokenTierIndexOrMax;
    mapping(address => uint256[]) private _userOwnedNfts;

    mapping(address => uint256) public activeMembershipId;
    mapping(address => uint256) public activeTierIndexOrMax;

    struct NFTDetail {
        uint256 tokenId;
        uint256 attribute;
        uint256 tierIndexOrMax;
        uint256 expiry;
        bool isExpired;
    }

    // ===== tiers =====
    struct Tier {
        uint256 minUsdc6;
        uint256 attr;
    }
    Tier[] public tiers;
    uint256 public defaultAttrWhenNoTiers = 0;

    event TiersUpdated(uint256 count);
    event TierAppended(uint256 index, uint256 minUsdc6, uint256 attr);
    event DefaultAttrUpdated(uint256 attr);

    event MemberNFTIssued(address indexed user, uint256 indexed tokenId, uint256 tierIndexOrMax, uint256 minUsdc6, uint256 expiry);
    event MemberNFTUpgraded(address indexed user, uint256 indexed oldActiveTokenId, uint256 indexed newTokenId, uint256 oldTierIndexOrMax, uint256 newTierIndex, uint256 newExpiry);

    event PointsUnitPriceUpdated(uint256 priceInCurrencyE18);

    event PointsPurchasedWithUSDC(
        address indexed payerEOA,
        address indexed beneficiaryAccount,
        address indexed usdc,
        uint256 usdcIn6,
        uint256 pointsMinted6,
        uint256 unitPointPriceUsdc6,
        bytes32 nonce
    );

    event AdminCardMinted(address indexed beneficiaryAccount, uint256 indexed tokenId, uint256 attr, uint256 expiry);
    event AdminPointsMinted(address indexed beneficiaryAccount, uint256 points6);

    // ===== Faucet data =====
    struct FaucetConfig {
        uint64 validUntil;
        uint64 perClaimMax;
        uint128 maxPerUser;
        uint128 maxGlobal;
        bool enabled;

        uint8 currency;
        uint8 decimals;           // MUST be 6
        uint128 priceInCurrency6; // 0 free; >0 priced
    }

    mapping(uint256 => FaucetConfig) public faucetConfig;
    mapping(uint256 => mapping(address => uint256)) public faucetClaimed; // id => (userEOA => claimed)
    mapping(uint256 => uint256) public faucetGlobalMinted;
    mapping(uint256 => bool) public faucetConfigFrozen;

    event FaucetConfigUpdated(uint256 indexed id, FaucetConfig cfg);
    event FaucetClaimed(uint256 indexed id, address indexed userEOA, address indexed acct, uint256 amount, uint256 claimedAfter);

    // ===== Open authorization =====
    mapping(bytes32 => uint256) public openAuthSpent;
    event OpenTransferAuthorized(
        address indexed fromEOA,
        address indexed fromAccount,
        uint256 indexed id,
        uint256 amount,
        uint256 maxAmount,
        bytes32 nonce,
        address toAccount
    );

    // ===== current index =====
    uint256 private _currentIndex = NFT_START_ID;

    constructor(
        string memory uri_,
        address initialOwner,
        address _gateway,
        address _redeemModule,
        BeamioCurrency.CurrencyType currency_,
        uint256 pointsUnitPriceInCurrencyE18_
    ) ERC1155(uri_) Ownable(initialOwner) {
        if (initialOwner == address(0)) revert BM_ZeroAddress();
        if (_gateway == address(0)) revert BM_ZeroAddress();
        if (_redeemModule == address(0)) revert BM_ZeroAddress();

        factoryGateway = _gateway;
        redeemModule = _redeemModule;
        currency = currency_;
        pointsUnitPriceInCurrencyE18 = pointsUnitPriceInCurrencyE18_;
        threshold = 1;

        isAdmin[initialOwner] = true;
        adminList.push(initialOwner);
    }

    // ===== modifiers =====
    modifier onlyAuthorizedGateway() {
        if (msg.sender != factoryGateway) revert UC_UnauthorizedGateway();
        _;
    }

    modifier onlyAdmin() {
        if (!isAdmin[msg.sender]) revert UC_NotAdmin();
        _;
    }

    // ==========================================================
    // Tier logic
    // ==========================================================

    function setDefaultAttr(uint256 attr) external onlyAdmin {
        emit DefaultAttrUpdated(defaultAttrWhenNoTiers);
        defaultAttrWhenNoTiers = attr;
    }

    function appendTier(uint256 minUsdc6, uint256 attr) external onlyAdmin {
        if (minUsdc6 == 0) revert UC_TierMinZero();
        if (tiers.length > 0) {
            Tier memory last = tiers[tiers.length - 1];
            if (minUsdc6 <= last.minUsdc6) revert UC_TiersNotIncreasing();
        }

        uint256 idx = tiers.length;
        tiers.push(Tier(minUsdc6, attr));
        emit TierAppended(idx, minUsdc6, attr);
    }

    function setTiers(Tier[] calldata newTiers) external onlyAdmin {
        if (newTiers.length == 0) revert UC_TierLenMismatch();

        for (uint256 i = 0; i < newTiers.length; i++) {
            if (newTiers[i].minUsdc6 == 0) revert UC_TierMinZero();
            if (i > 0 && newTiers[i].minUsdc6 <= newTiers[i - 1].minUsdc6) revert UC_TiersNotIncreasing();
        }

        delete tiers;
        for (uint256 i = 0; i < newTiers.length; i++) {
            tiers.push(newTiers[i]);
        }

        emit TiersUpdated(newTiers.length);
    }

    function getTiersCount() external view returns (uint256) { return tiers.length; }

    function getTierAt(uint256 idx) external view returns (Tier memory) { return tiers[idx]; }

    // ==========================================================
    // Pricing
    // ==========================================================

    function setPointsUnitPrice(uint256 priceInCurrencyE18) external onlyAdmin {
        if (priceInCurrencyE18 == 0) revert UC_PriceZero();
        pointsUnitPriceInCurrencyE18 = priceInCurrencyE18;
        emit PointsUnitPriceUpdated(priceInCurrencyE18);
    }

    function setExpirySeconds(uint256 secs) external onlyAdmin {
        emit ExpirySecondsUpdated(expirySeconds, secs);
        expirySeconds = secs;
    }

    function setRedeemModule(address newModule) external onlyAdmin {
        if (newModule == address(0)) revert BM_ZeroAddress();
        emit RedeemModuleUpdated(redeemModule, newModule);
        redeemModule = newModule;
    }

    // ==========================================================
    // Faucet configuration (frozen once)
    // ==========================================================

    function setFaucetConfig(
        uint256 id,
        uint64 validUntil,
        uint64 perClaimMax,
        uint128 maxPerUser,
        uint128 maxGlobal,
        bool enabled,
        BeamioCurrency.CurrencyType cur,
        uint128 priceInCurrency6
    ) external onlyAuthorizedGateway {
        if (faucetConfigFrozen[id]) revert UC_FaucetConfigFrozen();

        FaucetConfig storage cfg = faucetConfig[id];
        cfg.validUntil = validUntil;
        cfg.perClaimMax = perClaimMax;
        cfg.maxPerUser = maxPerUser;
        cfg.maxGlobal = maxGlobal;
        cfg.enabled = enabled;
        cfg.currency = uint8(cur);
        cfg.decimals = 6;
        cfg.priceInCurrency6 = priceInCurrency6;

        _validateFaucetConfig(cfg);
        faucetConfigFrozen[id] = true;

        emit FaucetConfigUpdated(id, cfg);
    }

    function _validateFaucetConfig(FaucetConfig memory cfg) private pure {
        if (!cfg.enabled && cfg.validUntil == 0) revert UC_FaucetConfigInvalid();
        if (cfg.decimals != 6) revert UC_FaucetConfigInvalid();
        if (cfg.perClaimMax == 0) revert UC_FaucetConfigInvalid();
        if (cfg.maxPerUser == 0 || cfg.maxGlobal == 0) revert UC_FaucetConfigInvalid();
    }

    // ==========================================================
    // Faucet (free)
    // ==========================================================

    function faucetByGateway(address userEOA, uint256 id, uint256 amount)
        external
        onlyAuthorizedGateway
        nonReentrant
    {
        if (userEOA == address(0)) revert BM_ZeroAddress();
        if (amount == 0) revert UC_AmountZero();

        FaucetConfig storage cfg = faucetConfig[id];
        if (!cfg.enabled) revert UC_FaucetNotEnabled();
        if (block.timestamp > cfg.validUntil) revert UC_FaucetExpired();
        if (amount > cfg.perClaimMax) revert UC_FaucetAmountTooLarge();
        if (!IBeamioFactoryOracle(factoryGateway).isTokenIdIssued(address(this), id)) revert UC_FaucetIdNotIssued();
        if (cfg.priceInCurrency6 != 0) revert UC_FaucetDisabledBecausePriced();

        if (faucetClaimed[id][userEOA] + amount > cfg.maxPerUser) revert UC_FaucetMaxExceeded();
        if (faucetGlobalMinted[id] + amount > cfg.maxGlobal) revert UC_FaucetGlobalMaxExceeded();

        faucetClaimed[id][userEOA] += amount;
        faucetGlobalMinted[id] += amount;

        address acct = _resolveAccount(userEOA);
        _mint(acct, id, amount, "");

        emit FaucetClaimed(id, userEOA, acct, amount, faucetClaimed[id][userEOA]);
    }

    // ==========================================================
    // Faucet (paid) via ERC-3009
    // ==========================================================

    function faucetPurchaseWith3009AuthorizationByGateway(
        address userEOA,
        uint256 id,
        uint256 amount6,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external onlyAuthorizedGateway nonReentrant {
        if (userEOA == address(0)) revert BM_ZeroAddress();
        if (amount6 == 0) revert UC_AmountZero();

        FaucetConfig storage cfg = faucetConfig[id];
        if (!cfg.enabled) revert UC_FaucetNotEnabled();
        if (block.timestamp > cfg.validUntil) revert UC_FaucetExpired();
        if (amount6 > cfg.perClaimMax) revert UC_FaucetAmountTooLarge();
        if (!IBeamioFactoryOracle(factoryGateway).isTokenIdIssued(address(this), id)) revert UC_FaucetIdNotIssued();
        if (cfg.priceInCurrency6 == 0) revert UC_PurchaseDisabledBecauseFree();

        if (faucetClaimed[id][userEOA] + amount6 > cfg.maxPerUser) revert UC_FaucetMaxExceeded();
        if (faucetGlobalMinted[id] + amount6 > cfg.maxGlobal) revert UC_FaucetGlobalMaxExceeded();

        uint256 usdcAmount6 = IBeamioFactoryOracle(factoryGateway).quoteCurrencyAmountInUSDC6(
            cfg.currency,
            (uint256(cfg.priceInCurrency6) * amount6) / 1e6
        );

        _executeUSDC3009Transfer(userEOA, usdcAmount6, validAfter, validBefore, nonce, signature);

        faucetClaimed[id][userEOA] += amount6;
        faucetGlobalMinted[id] += amount6;

        address acct = _resolveAccount(userEOA);
        _mint(acct, id, amount6, "");

        
    }

    // ==========================================================
    // Redeem by gateway (delegatecall)
    // 强制 mint 目标为 AA account：
    //  - 入参 user 视为 userEOA
    //  - mint 到 _resolveAccount(userEOA)
    // ==========================================================

    function redeemByGateway(string calldata pwd, address user)
        external
        onlyAuthorizedGateway
        nonReentrant
    {
        // user is userEOA
        if (user == address(0)) revert BM_ZeroAddress();
        if (redeemModule == address(0)) revert UC_RedeemModuleZero();

        (bool ok, bytes memory data) = redeemModule.delegatecall(
            abi.encodeWithSignature("consumeRedeem(string,address)", pwd, user)
        );
        if (!ok) revert UC_RedeemDelegateFailed(data);

        (uint256 points6, , uint256 tokenId, uint256 tokenAmt) =
            abi.decode(data, (uint256, uint256, uint256, uint256));

        address acct = _resolveAccount(user);

        if (points6 > 0) _mint(acct, POINTS_ID, points6, "");
        if (tokenId != 0 && tokenAmt > 0) _mint(acct, tokenId, tokenAmt, "");
    }

    // ==========================================================
    // Open authorization (points transfer)
    // ==========================================================

    function transferWithOpenAuthorizationByGateway(
        address fromEOA,
        address toEOA,
        uint256 id,
        uint256 amount,
        uint256 maxAmount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata sig
    ) external onlyAuthorizedGateway nonReentrant {
        if (fromEOA == address(0) || toEOA == address(0)) revert BM_ZeroAddress();
        if (amount == 0 || amount > maxAmount) revert UC_AmountZero();
        if (id != POINTS_ID) revert UC_PointsToNotWhitelisted();

        bytes32 h = MessageHashUtils.toEthSignedMessageHash(
            keccak256(
                abi.encode(
                    "OpenTransfer",
                    factoryGateway,
                    address(this),
                    fromEOA,
                    id,
                    maxAmount,
                    validAfter,
                    validBefore,
                    nonce
                )
            )
        );

        address recovered = ECDSA.recover(h, sig);
        if (recovered != fromEOA) revert UC_PointsToNotWhitelisted();
        if (block.timestamp < validAfter || block.timestamp > validBefore) revert UC_PointsToNotWhitelisted();

        if (openAuthSpent[nonce] + amount > maxAmount) revert UC_Slippage();
        openAuthSpent[nonce] += amount;

        address fromAccount = _resolveAccount(fromEOA);
        address toAccount = _resolveAccount(toEOA);

        _safeTransferFrom(fromAccount, toAccount, id, amount, "");

        emit OpenTransferAuthorized(fromEOA, fromAccount, id, amount, maxAmount, nonce, toAccount);
    }

    // ==========================================================
    // Points purchase (ERC-3009)
    // ==========================================================

    function buyPointsWith3009Authorization(
        address fromEOA,
        uint256 usdcAmount6,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature,
        uint256 minPointsOut6
    ) external nonReentrant returns (uint256 pointsOut6) {
        if (fromEOA == address(0)) revert BM_ZeroAddress();
        if (usdcAmount6 == 0) revert UC_AmountZero();

        address acct = _resolveAccount(fromEOA);

        uint256 unitPriceUsdc6 = IBeamioFactoryOracle(factoryGateway).quoteUnitPointInUSDC6(address(this));
        if (unitPriceUsdc6 == 0) revert UC_PriceZero();

        pointsOut6 = (usdcAmount6 * POINTS_ONE) / unitPriceUsdc6;
        if (pointsOut6 == 0) revert UC_PointsZero();
        if (pointsOut6 < minPointsOut6) revert UC_Slippage();

        _syncActiveToBestValid(acct);

        // ========== 修改：新的Tier逻辑 ==========
        // 如果已定义Tier（tiers.length > 0），则检查门槛
        if (tiers.length > 0) {
            bool isNewUser = (activeMembershipId[acct] == 0 || _isExpired(activeMembershipId[acct]));
            if (isNewUser) {
                uint256 projectedBalance = balanceOf(acct, POINTS_ID) + pointsOut6;
                (bool okTier, , ) = _tierFromPointsValue(projectedBalance);
                if (!okTier) revert UC_BelowMinThreshold();
            }
        }
        // 如果未定义Tier（tiers.length == 0），不检查任何门槛，直接购买

        _executeUSDC3009Transfer(fromEOA, usdcAmount6, validAfter, validBefore, nonce, signature);
        _mint(acct, POINTS_ID, pointsOut6, "");

        emit PointsPurchasedWithUSDC(
            fromEOA,
            acct,
            IBeamioFactoryOracle(factoryGateway).USDC(),
            usdcAmount6,
            pointsOut6,
            unitPriceUsdc6,
            nonce
        );

        return pointsOut6;
    }

    function _executeUSDC3009Transfer(
        address fromEOA,
        uint256 val,
        uint256 afterTs,
        uint256 beforeTs,
        bytes32 nonce,
        bytes calldata sig
    ) internal {
        address usdc = IBeamioFactoryOracle(factoryGateway).USDC();
        if (usdc == address(0)) revert BM_ZeroAddress();

        address merchant = owner();
        if (merchant == address(0)) revert BM_ZeroAddress();

        IERC3009BytesSig(usdc).transferWithAuthorization(fromEOA, merchant, val, afterTs, beforeTs, nonce, sig);
    }

    // ==========================================================
    // Admin minting
    // ==========================================================

    function mintPointsByAdmin(address user, uint256 points6) external onlyAdmin nonReentrant {
        if (user == address(0)) revert BM_ZeroAddress();
        if (points6 == 0) revert UC_AmountZero();

        _mint(user, POINTS_ID, points6, "");
        _maybeIssueOrUpgradeByPointsBalance(user);

        emit AdminPointsMinted(user, points6);
    }

    function _addAdmin(address newAdmin, uint256 newThreshold) internal {
        if (newAdmin == address(0)) revert BM_ZeroAddress();

        if (!isAdmin[newAdmin]) {
            isAdmin[newAdmin] = true;
            adminList.push(newAdmin);
        }

        if (newThreshold > adminList.length) revert UC_InvalidProposal();
        threshold = newThreshold;
    }

    function addAdmin(address newAdmin, uint256 newThreshold) public onlyAdmin {
        _addAdmin(newAdmin, newThreshold);
    }

    // ==========================================================
    // Internal helpers
    // ==========================================================

    function _isExpired(uint256 tokenId) internal view returns (bool) {
        uint256 exp = expiresAt[tokenId];
        return (exp != 0 && block.timestamp > exp);
    }

    function _syncActiveToBestValid(address user) internal {
        uint256[] storage nftIds = _userOwnedNfts[user];
        if (nftIds.length == 0) {
            activeMembershipId[user] = 0;
            activeTierIndexOrMax[user] = type(uint256).max;
            return;
        }

        uint256 bestId = 0;
        uint256 bestTierIndex = type(uint256).max;

        for (uint256 i = 0; i < nftIds.length; i++) {
            uint256 id = nftIds[i];
            if (_isExpired(id)) continue;

            uint256 tierIdx = tokenTierIndexOrMax[id];
            if (tierIdx < bestTierIndex) {
                bestId = id;
                bestTierIndex = tierIdx;
            }
        }

        activeMembershipId[user] = bestId;
        activeTierIndexOrMax[user] = bestTierIndex;
    }

    function _tierFromPointsValue(uint256 points6)
        internal
        view
        returns (bool ok, uint256 tierIndex, uint256 attr)
    {
        if (tiers.length == 0) return (true, type(uint256).max, defaultAttrWhenNoTiers);

        for (uint256 i = 0; i < tiers.length; i++) {
            if (points6 >= tiers[i].minUsdc6) {
                tierIndex = i;
                ok = true;
            }
        }

        attr = ok ? tiers[tierIndex].attr : 0;
    }

    function _maybeIssueOrUpgradeByPointsBalance(address user) internal {
        _syncActiveToBestValid(user);

        // ========== 修改：新逻辑 ==========
        if (tiers.length == 0) {
            // 未定义Tier：检查用户是否已有ID >= 100的有效NFT
            uint256 currentActiveId = activeMembershipId[user];
            if (currentActiveId != 0 && !_isExpired(currentActiveId)) {
                // 用户已有有效的NFT，不再发行
                return;
            }

            // 用户没有有效的NFT，自动发行一张
            uint256 expiry = (expirySeconds == 0) ? 0 : (block.timestamp + expirySeconds);
            uint256 newId = _currentIndex++;

            expiresAt[newId] = expiry;
            attributes[newId] = defaultAttrWhenNoTiers;
            tokenTierIndexOrMax[newId] = type(uint256).max;  // 表示无tier
            _userOwnedNfts[user].push(newId);

            emit MemberNFTIssued(user, newId, type(uint256).max, 0, expiry);

            activeMembershipId[user] = newId;
            activeTierIndexOrMax[user] = type(uint256).max;
        } else {
            // 已定义Tier：按原逻辑执行
            uint256 points = balanceOf(user, POINTS_ID);
            (bool okTier, uint256 tierIdx, uint256 attr) = _tierFromPointsValue(points);
            if (!okTier) return;

            uint256 currentActiveId = activeMembershipId[user];
            if (currentActiveId != 0 && !_isExpired(currentActiveId)) {
                uint256 currentTierIdx = activeTierIndexOrMax[user];
                if (currentTierIdx <= tierIdx) return;
            }

            uint256 expiry = (expirySeconds == 0) ? 0 : (block.timestamp + expirySeconds);
            uint256 newId = _currentIndex++;

            expiresAt[newId] = expiry;
            attributes[newId] = attr;
            tokenTierIndexOrMax[newId] = tierIdx;
            _userOwnedNfts[user].push(newId);

            if (currentActiveId != 0) {
                emit MemberNFTUpgraded(user, currentActiveId, newId, activeTierIndexOrMax[user], tierIdx, expiry);
            } else {
                emit MemberNFTIssued(user, newId, tierIdx, tiers[tierIdx].minUsdc6, expiry);
            }

            activeMembershipId[user] = newId;
            activeTierIndexOrMax[user] = tierIdx;
        }
    }

    function _maybeUpgradeOnlyByPointsBalance(address user) internal {
         _syncActiveToBestValid(user);

    uint256 currentActiveId = activeMembershipId[user];

    // ========== tiers.length == 0：自动补发 ==========
    if (tiers.length == 0) {
        if (currentActiveId == 0 || _isExpired(currentActiveId)) {
            _maybeIssueOrUpgradeByPointsBalance(user);
        }
        return;
    }

    // ========== tiers.length > 0：按Tier升级 ==========
    uint256 points = balanceOf(user, POINTS_ID);
        (bool okTier, uint256 tierIdx, uint256 attr) = _tierFromPointsValue(points);

        if (currentActiveId == 0 || _isExpired(currentActiveId)) {
            if (okTier) _maybeIssueOrUpgradeByPointsBalance(user);
            return;
        }

        uint256 currentTierIdx = activeTierIndexOrMax[user];
        if (!okTier || currentTierIdx <= tierIdx) return;

        uint256 expiry = (expirySeconds == 0) ? 0 : (block.timestamp + expirySeconds);
        uint256 newId = _currentIndex++;

        expiresAt[newId] = expiry;
        attributes[newId] = attr;
        tokenTierIndexOrMax[newId] = tierIdx;
        _userOwnedNfts[user].push(newId);

        emit MemberNFTUpgraded(
            user,
            currentActiveId,
            newId,
            currentTierIdx,
            tierIdx,
            expiry
        );

        activeMembershipId[user] = newId;
        activeTierIndexOrMax[user] = tierIdx;
    }

    function _resolveAccount(address eoa) internal view returns (address) {
        address factory = IBeamioFactoryOracle(factoryGateway).aaFactory();
        if (factory == address(0)) revert UC_GlobalMisconfigured();

        address acct = IBeamioAccountFactoryV07(factory).beamioAccountOf(eoa);
        if (acct == address(0) || acct.code.length == 0) revert UC_NoBeamioAccount();
        return acct;
    }

    // ==========================================================
    // Multisig governance
    // ==========================================================

    function createProposal(bytes4 selector, address target, uint256 v1, uint256 v2, uint256 v3)
        external
        onlyAuthorizedGateway
        returns (uint256)
    {
        uint256 id = proposalCount++;
        proposals[id] = Proposal(target, v1, v2, v3, selector, 0, false);
        emit ProposalCreated(id, selector, msg.sender);

        if (isAdmin[msg.sender]) _approve(id, msg.sender);
        return id;
    }

    function approveProposalByGateway(uint256 id, address adminSigner) external {
        if (msg.sender != factoryGateway) revert UC_UnauthorizedGateway();
        if (!isAdmin[adminSigner]) revert UC_NotAdmin();
        _approve(id, adminSigner);
    }

    function approveProposal(uint256 id) external onlyAdmin {
        _approve(id, msg.sender);
    }

    function _approve(uint256 id, address admin) internal {
        Proposal storage p = proposals[id];
        if (p.executed) revert UC_InvalidProposal();
        if (isApproved[id][admin]) revert UC_InvalidProposal();

        isApproved[id][admin] = true;
        p.approvals++;
        emit ProposalApproved(id, admin);

        if (p.approvals >= threshold) _execute(id);
    }

    function _execute(uint256 id) internal {
        Proposal storage p = proposals[id];
        if (p.executed) revert UC_InvalidProposal();
        p.executed = true;

        if (p.selector == 0x70fc060d) {
            _addAdmin(p.target, p.v1);
        } else if (p.selector == 0x40c10f19) {
            _mint(p.target, POINTS_ID, p.v1, "");
        } else if (p.selector == 0x6e9f167e) {
            _mintMemberCardInternal(p.target, p.v2);
        } else if (p.selector == 0x276639b5) {
            if (p.v1 > 0) _mintMemberCardInternal(p.target, p.v2);
            if (p.v3 > 0) _mint(p.target, POINTS_ID, p.v3, "");
        } else if (p.selector == 0xe2316652) {
            _setTransferWhitelist(p.target, p.v1 == 1);
        }

        emit ProposalExecuted(id);
    }

    function _setTransferWhitelist(address target, bool allowed) internal {
        transferWhitelist[target] = allowed;
    }

    function setTransferWhitelist(address target, bool allowed) external onlyAdmin {
        _setTransferWhitelist(target, allowed);
    }

    function mintMemberCardByAdmin(address user, uint256 tierIndex) external onlyAdmin nonReentrant {
        _mintMemberCardInternal(user, tierIndex);
    }

    function _mintMemberCardInternal(address user, uint256 tierIndex) internal {
        if (user == address(0)) revert BM_ZeroAddress();
        if (tiers.length == 0) revert UC_MustGrow();
        if (tierIndex >= tiers.length) revert UC_MustGrow();

        uint256 currentActiveId = activeMembershipId[user];
        if (currentActiveId != 0 && !_isExpired(currentActiveId)) revert UC_AlreadyHasValidCard();

        uint256 newId = _currentIndex++;
        Tier memory tier = tiers[tierIndex];

        expiresAt[newId] = (expirySeconds == 0) ? 0 : (block.timestamp + expirySeconds);
        attributes[newId] = tier.attr;
        tokenTierIndexOrMax[newId] = tierIndex;
        _userOwnedNfts[user].push(newId);
        activeMembershipId[user] = newId;
        activeTierIndexOrMax[user] = tierIndex;

        emit AdminCardMinted(user, newId, tier.attr, expiresAt[newId]);
    }

    // ==========================================================
    // ERC1155 update hook
    // ==========================================================

    function _update(address from, address to, uint256[] memory ids, uint256[] memory values) internal override {
        bool isRealTransfer = (from != address(0) && to != address(0));

        for (uint256 i = 0; i < ids.length; i++) {
            uint256 id = ids[i];

            if (id >= NFT_START_ID && id < ISSUED_NFT_START_ID) {
                if (!(from == address(0) || to == address(0))) revert UC_SBTNonTransferable();
                if (to == address(0) && from != address(0)) _removeNft(from, id);
                continue;
            }

            if (id == POINTS_ID && isRealTransfer) {
                if (!transferWhitelist[address(0)]) {
                    if (!transferWhitelist[to]) revert UC_PointsToNotWhitelisted();
                }

                address f = IBeamioFactoryOracle(factoryGateway).aaFactory();
                if (f == address(0)) revert UC_GlobalMisconfigured();

                if (!IBeamioAccountFactoryV07(f).isBeamioAccount(to)) revert UC_NoBeamioAccount();
                if (to.code.length == 0) revert UC_NoBeamioAccount();
            }
        }

        super._update(from, to, ids, values);

        bool touchedPoints = false;
        for (uint256 j = 0; j < ids.length; j++) {
            if (ids[j] == POINTS_ID) { touchedPoints = true; break; }
        }
        if (!touchedPoints) return;

        if (from == address(0) && to != address(0)) {
            _maybeIssueOrUpgradeByPointsBalance(to);
            return;
        }
        if (from != address(0) && to != address(0)) {
            _maybeUpgradeOnlyByPointsBalance(from);
            return;
        }
    }

    function _removeNft(address user, uint256 id) internal {
        uint256[] storage list = _userOwnedNfts[user];
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == id) {
                list[i] = list[list.length - 1];
                list.pop();
                break;
            }
        }
        if (activeMembershipId[user] == id) {
            activeMembershipId[user] = 0;
            activeTierIndexOrMax[user] = type(uint256).max;
        }
    }

    // ==========================================================
    // Views
    // ==========================================================

    function getOwnership(address user) external view returns (uint256 pt, NFTDetail[] memory nfts) {
        uint256[] storage nftIds = _userOwnedNfts[user];
        nfts = new NFTDetail[](nftIds.length);

        for (uint256 i = 0; i < nftIds.length; i++) {
            uint256 id = nftIds[i];
            uint256 exp = expiresAt[id];
            bool expired = (exp != 0 && block.timestamp > exp);

            nfts[i] = NFTDetail(id, attributes[id], tokenTierIndexOrMax[id], exp, expired);
        }

        return (balanceOf(user, POINTS_ID), nfts);
    }
}
