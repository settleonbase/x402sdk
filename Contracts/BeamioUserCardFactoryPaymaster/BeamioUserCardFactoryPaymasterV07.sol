// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./BeamioUserCard.sol";
import "./BeamioCurrency.sol";

error NotAuthorized();
error ZeroAddress();
error InvalidRedeemHash();
error BadDeployedCard();
error AlreadyRegistered();

interface IBeamioQuoteHelper {
    function quoteCurrencyAmountInUSDC6(uint8 cur, uint256 amount6) external view returns (uint256);
    function quoteUnitPointInUSDC6(uint8 cardCurrency, uint256 unitPointPriceInCurrencyE18) external view returns (uint256);
}

interface IBeamioDeployerV07 {
    function deploy(bytes calldata initCode) external returns (address);
}

contract BeamioUserCardFactoryPaymasterV07 is IBeamioFactoryOracle {
    address public constant USDC_TOKEN = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    address public owner;
    address public defaultRedeemModule;

    address public quoteHelper;
    address public deployer;

    // AA factory (BeamioFactoryPaymasterV07)
    address public _aaFactory;

    mapping(address => bool) public isPaymaster;

    // id issuance
    uint256 public nextFungibleId = 1;
    uint256 public nextNftId = 100000000;
    mapping(address => mapping(uint256 => bool)) public tokenIdIssued;

    // owner -> cards
    mapping(address => address[]) private _cardsOfOwner;
    mapping(address => mapping(address => bool)) public isCardOfOwner;

    event OwnerChanged(address indexed oldOwner, address indexed newOwner);
    event PaymasterStatusChanged(address indexed account, bool allowed);
    event DefaultRedeemModuleUpdated(address indexed oldM, address indexed newM);
    event QuoteHelperChanged(address indexed oldH, address indexed newH);
    event DeployerChanged(address indexed oldD, address indexed newD);
    event AAFactoryChanged(address indexed oldFactory, address indexed newFactory);

    event CardDeployed(address indexed cardOwner, address indexed card, uint8 currency, uint256 price);
    event CardRegistered(address indexed cardOwner, address indexed card);
    event RedeemExecuted(address indexed card, address indexed user, bytes32 redeemHash);
    event TokenIdIssued(address indexed card, uint256 indexed id, bool isNft);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotAuthorized();
        _;
    }

    modifier onlyPaymaster() {
        if (!(msg.sender == owner || isPaymaster[msg.sender])) revert NotAuthorized();
        _;
    }

    constructor(address redeemModule_, address quoteHelper_, address deployer_, address aaFactory_) {
        if (redeemModule_ == address(0) || quoteHelper_ == address(0) || deployer_ == address(0) || aaFactory_ == address(0)) {
            revert ZeroAddress();
        }

        owner = msg.sender;
        isPaymaster[msg.sender] = true;

        defaultRedeemModule = redeemModule_;
        quoteHelper = quoteHelper_;
        deployer = deployer_;
        _aaFactory = aaFactory_;
    }

    // ===== IBeamioFactoryOracle =====
    function USDC() external pure returns (address) { return USDC_TOKEN; }

    function aaFactory() external view returns (address) { return _aaFactory; }

    function isTokenIdIssued(address card, uint256 id) external view returns (bool) { return tokenIdIssued[card][id]; }

    function quoteCurrencyAmountInUSDC6(uint8 cur, uint256 amount6) external view returns (uint256) {
        return IBeamioQuoteHelper(quoteHelper).quoteCurrencyAmountInUSDC6(cur, amount6);
    }

    function quoteUnitPointInUSDC6(address card) external view returns (uint256) {
        BeamioUserCard c = BeamioUserCard(card);
        return IBeamioQuoteHelper(quoteHelper).quoteUnitPointInUSDC6(uint8(c.currency()), c.pointsUnitPriceInCurrencyE18());
    }

    // ===== owner->cards view =====
    function cardsOfOwner(address cardOwner) external view returns (address[] memory) {
        return _cardsOfOwner[cardOwner];
    }

    function latestCardOfOwner(address cardOwner) external view returns (address) {
        uint256 n = _cardsOfOwner[cardOwner].length;
        return n == 0 ? address(0) : _cardsOfOwner[cardOwner][n - 1];
    }

    // ===== admin =====
    function setQuoteHelper(address h) external onlyOwner {
        if (h == address(0)) revert ZeroAddress();
        emit QuoteHelperChanged(quoteHelper, h);
        quoteHelper = h;
    }

    function setDeployer(address d) external onlyOwner {
        if (d == address(0)) revert ZeroAddress();
        emit DeployerChanged(deployer, d);
        deployer = d;
    }

    function setRedeemModule(address m) external onlyOwner {
        if (m == address(0)) revert ZeroAddress();
        emit DefaultRedeemModuleUpdated(defaultRedeemModule, m);
        defaultRedeemModule = m;
    }

    function setAAFactory(address f) external onlyOwner {
        if (f == address(0)) revert ZeroAddress();
        emit AAFactoryChanged(_aaFactory, f);
        _aaFactory = f;
    }

    function transferOwner(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    function changePaymasterStatus(address a, bool ok) external onlyOwner {
        isPaymaster[a] = ok;
        emit PaymasterStatusChanged(a, ok);
    }

    // ===== id issuance =====
    function issueTokenId(address card, bool isNft) external onlyPaymaster returns (uint256 id) {
        if (card == address(0) || card.code.length == 0) revert ZeroAddress();
        if (BeamioUserCard(card).factoryGateway() != address(this)) revert NotAuthorized();

        id = isNft ? nextNftId++ : nextFungibleId++;
        tokenIdIssued[card][id] = true;
        emit TokenIdIssued(card, id, isNft);
    }

    // ==========================================================
    // Deploy with initCode (creationCode + abi.encode(args))
    // args MUST match BeamioUserCard constructor:
    // (uri, initialOwner, gateway, redeemModule, currency, pointsUnitPriceInCurrencyE18)
    // ==========================================================
    function createCardCollectionWithInitCode(
        address cardOwner,
        uint8 currency,
        uint256 priceInCurrencyE18,
        bytes calldata initCode
    ) external onlyPaymaster returns (address card) {
        if (cardOwner == address(0)) revert ZeroAddress();

        card = IBeamioDeployerV07(deployer).deploy(initCode);

        // validate
        BeamioUserCard c = BeamioUserCard(card);
        if (c.factoryGateway() != address(this)) revert BadDeployedCard();
        if (c.owner() != cardOwner) revert BadDeployedCard();
        if (uint8(c.currency()) != currency) revert BadDeployedCard();
        if (c.pointsUnitPriceInCurrencyE18() != priceInCurrencyE18) revert BadDeployedCard();

        _registerCard(cardOwner, card);
        emit CardDeployed(cardOwner, card, currency, priceInCurrencyE18);
    }

    /// @notice 如果你“手动部署了 BeamioUserCard”，也可以注册进 Factory 方便查询（可选）
    function registerExistingCard(address cardOwner, address card) external onlyPaymaster {
        if (cardOwner == address(0) || card == address(0)) revert ZeroAddress();
        if (isCardOfOwner[cardOwner][card]) revert AlreadyRegistered();

        BeamioUserCard c = BeamioUserCard(card);
        if (c.factoryGateway() != address(this)) revert BadDeployedCard();
        if (c.owner() != cardOwner) revert BadDeployedCard();

        _registerCard(cardOwner, card);
        emit CardRegistered(cardOwner, card);
    }

    function _registerCard(address cardOwner, address card) internal {
        isCardOfOwner[cardOwner][card] = true;
        _cardsOfOwner[cardOwner].push(card);
    }

    // ===== redeem =====
    function redeemForUser(address cardAddr, string calldata pwd, address user) external onlyPaymaster {
        if (user == address(0)) revert ZeroAddress();
        if (BeamioUserCard(cardAddr).factoryGateway() != address(this)) revert NotAuthorized();

        // 如果你还想保留“空字符串不允许”
        if (bytes(pwd).length == 0) revert InvalidRedeemHash();

        BeamioUserCard(cardAddr).redeemByGateway(pwd, user);
        emit RedeemExecuted(cardAddr, user, keccak256(bytes(pwd)));
    }
}
