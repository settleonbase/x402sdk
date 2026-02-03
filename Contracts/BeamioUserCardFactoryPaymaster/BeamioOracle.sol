// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./BeamioCurrency.sol";

contract BeamioOracle is Ownable {
    error OracleError();
    error RateLimitExceeded();
    error ArrayLengthMismatch();

    uint256 private constant E18 = 1e18;

    struct Breaker {
        uint16 maxChangeBps;   // 0 => use defaultMaxRateChangeBps
        uint120 minRateE18;    // 0 => no floor
        uint120 maxRateE18;    // 0 => no cap
    }

    mapping(uint8 => uint256) public rates;        // currencyId => USD rate (E18)
    mapping(uint8 => Breaker) public breakers;

    uint256 public defaultMaxRateChangeBps = 2000;

    event RateUpdated(uint8 indexed currency, uint256 oldRate, uint256 newRate);
    event BreakerUpdated(uint8 indexed currency, uint16 maxChangeBps, uint120 minRateE18, uint120 maxRateE18);
    event DefaultMaxChangeUpdated(uint256 oldBps, uint256 newBps);

    constructor() Ownable(msg.sender) {
        rates[BeamioCurrency.USD] = E18;
        rates[BeamioCurrency.USDC] = E18;
    }

    // ================= Admin Functions =================

    function setDefaultMaxRateChangeBps(uint256 bps) external onlyOwner {
        if (bps > 10000) revert RateLimitExceeded();
        emit DefaultMaxChangeUpdated(defaultMaxRateChangeBps, bps);
        defaultMaxRateChangeBps = bps;
    }

    function setBreaker(uint8 c, uint16 bps, uint120 minR, uint120 maxR) external onlyOwner {
        if (bps > 10000) revert RateLimitExceeded();
        if (maxR != 0 && minR != 0 && maxR < minR) revert RateLimitExceeded();
        breakers[c] = Breaker(bps, minR, maxR);
        emit BreakerUpdated(c, bps, minR, maxR);
    }

    // ================= Update Functions (The Fix) =================

    /**
     * @notice 批量更新汇率，一次写入所有喂料
     * @param cs 货币 ID 数组
     * @param rs 对应的汇率数组 (E18 精度)
     */
    function updateRatesBatch(uint8[] calldata cs, uint256[] calldata rs) external onlyOwner {
        if (cs.length != rs.length) revert ArrayLengthMismatch();
        
        for (uint256 i = 0; i < cs.length; i++) {
            _setRate(cs[i], rs[i]);
        }
    }

    /**
     * @notice 单个更新汇率
     */
    function updateRate(uint8 c, uint256 rateE18) external onlyOwner {
        _setRate(c, rateE18);
    }

    /**
     * @dev 核心逻辑抽取，包含波动率和硬上限检查
     */
    function _setRate(uint8 c, uint256 rateE18) private {
        if (rateE18 == 0) revert OracleError();

        // 保护：USD 必须是 1.0 (ID: 1)
        if (c == BeamioCurrency.USD && rateE18 != E18) revert OracleError();

        Breaker memory b = breakers[c];

        // 硬性上下限检查 (minRateE18 / maxRateE18)
        if ((b.minRateE18 != 0 && rateE18 < b.minRateE18) || (b.maxRateE18 != 0 && rateE18 > b.maxRateE18)) {
            revert RateLimitExceeded();
        }

        uint256 old = rates[c];

        // 波动率检查 (maxChangeBps)
        if (old != 0) {
            uint256 maxBps = b.maxChangeBps == 0 ? defaultMaxRateChangeBps : b.maxChangeBps;
            uint256 lower = (old * (10000 - maxBps)) / 10000;
            uint256 upper = (old * (10000 + maxBps)) / 10000;
            if (rateE18 < lower || rateE18 > upper) revert RateLimitExceeded();
        }

        rates[c] = rateE18;
        emit RateUpdated(c, old, rateE18);
    }

    function getRate(uint8 c) external view returns (uint256) {
        uint256 r = rates[c];
        if (r == 0) revert OracleError();
        return r;
    }
}