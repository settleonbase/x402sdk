// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./BeamioUserCard.sol";
import "./BeamioCurrency.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

error NotAuthorized();
error ZeroAddress();
error SecretUsed();
error CallFailed();
error InvalidSecret();

interface IFactoryV07 {
    function owner() external view returns (address);
    function isPaymaster(address a) external view returns (bool);

    function issueTokenId(address card, bool isNft) external returns (uint256);
}

contract BeamioUserCardGatewayExecutorV07 {
    using ECDSA for bytes32;

    address public immutable factory; // BeamioUserCardFactoryPaymasterV07
    mapping(bytes32 => bool) public usedMetaSecrets;

    constructor(address factory_) {
        if (factory_ == address(0) || factory_.code.length == 0) revert ZeroAddress();
        factory = factory_;
    }

    modifier onlyPaymaster() {
        address o = IFactoryV07(factory).owner();
        if (msg.sender != o && !IFactoryV07(factory).isPaymaster(msg.sender)) revert NotAuthorized();
        _;
    }

    // ===== meta-tx admin action (kept same signature) =====
    function executeAdminAction(
        address coll,
        bytes calldata data,
        bytes32 secret,
        bytes calldata sig
    ) external onlyPaymaster {
        if (secret == bytes32(0)) revert InvalidSecret();
        if (usedMetaSecrets[secret]) revert SecretUsed();
        if (coll.code.length == 0) revert CallFailed();

        BeamioUserCard card = BeamioUserCard(coll);
        if (card.factoryGateway() != factory) revert NotAuthorized();

        bytes32 h = MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode(factory, coll, keccak256(data), secret, block.chainid))
        );

        address signer = ECDSA.recover(h, sig);
        if (!(card.isAdmin(signer) || signer == card.owner())) revert NotAuthorized();

        usedMetaSecrets[secret] = true;

        // ✅ 不做 revert reason bubble（能显著省字节码）
        (bool ok, ) = coll.call(data);
        if (!ok) revert CallFailed();
    }

    // ==========================================================
    // Offline open transfer redeem (same signature)
    // ==========================================================
    function redeemOpenTransfer(
        address card,
        address fromEOA,
        address toEOA,
        uint256 id,
        uint256 amount,
        uint256 maxAmount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata sig
    ) external onlyPaymaster {
        if (BeamioUserCard(card).factoryGateway() != factory) revert NotAuthorized();

        BeamioUserCard(card).transferWithOpenAuthorizationByGateway(
            fromEOA, toEOA, id, amount, maxAmount, validAfter, validBefore, nonce, sig
        );
    }

    // ==========================================================
    // Faucet (free) via paymaster (same signature)
    // ==========================================================
    function faucetFor(
        address cardAddr,
        address userEOA,
        uint256 id,
        uint256 amount
    ) external onlyPaymaster {
        if (cardAddr == address(0) || userEOA == address(0)) revert ZeroAddress();
        if (BeamioUserCard(cardAddr).factoryGateway() != factory) revert NotAuthorized();

        BeamioUserCard(cardAddr).faucetByGateway(userEOA, id, amount);
    }

    // ==========================================================
    // Faucet (paid) via paymaster (same signature)
    // ==========================================================
    function faucetPurchaseFor(
        address cardAddr,
        address userEOA,
        uint256 id,
        uint256 amount6,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata sig
    ) external onlyPaymaster {
        if (cardAddr == address(0) || userEOA == address(0)) revert ZeroAddress();
        if (BeamioUserCard(cardAddr).factoryGateway() != factory) revert NotAuthorized();

        BeamioUserCard(cardAddr).faucetPurchaseWith3009AuthorizationByGateway(
            userEOA, id, amount6, validAfter, validBefore, nonce, sig
        );
    }

    // ==========================================================
    // One-shot workflow: issue id + freeze faucet config (same signature)
    // ==========================================================
    function issueIdAndFreezeFaucetConfig(
        address cardAddr,
        bool isNft,
        uint64 validUntil,
        uint64 perClaimMax,
        uint128 maxPerUser,
        uint128 maxGlobal,
        bool enabled,
        BeamioCurrency.CurrencyType cur,
        uint128 priceInCurrency6
    ) external onlyPaymaster returns (uint256 id) {
        if (cardAddr == address(0)) revert ZeroAddress();
        if (BeamioUserCard(cardAddr).factoryGateway() != factory) revert NotAuthorized();

        id = IFactoryV07(factory).issueTokenId(cardAddr, isNft);

        BeamioUserCard(cardAddr).setFaucetConfig(
            id,
            validUntil,
            perClaimMax,
            maxPerUser,
            maxGlobal,
            enabled,
            cur,
            priceInCurrency6
        );
    }
}
