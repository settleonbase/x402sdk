// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {LibDiamond} from "../libraries/LibDiamond.sol";
import {LibStatsStorage} from "../libraries/LibStatsStorage.sol";

contract StatsFacet {
    // 防止 getAggregatedStats for-loop 范围过大导致 OOG（默认最多 90 天）
    uint256 public constant MAX_HOURS = 2160;

    struct AggregatedStats {
        uint256 totalNftMinted;
        uint256 totalTokenMinted;
        uint256 totalTokenBurned;
        uint256 totalTransfers;
    }

    event StatsUpdated(uint256 indexed hourIndex, address indexed card, address indexed user);

    function recordDetailedActivity(
        address card,
        address user,
        uint256 nftCount,
        uint256 mintAmount,
        uint256 burnAmount,
        uint256 transfers
    ) external {
        LibDiamond.enforceIsContractOwner();
        _recordDetailedActivityAt(block.timestamp, card, user, nftCount, mintAmount, burnAmount, transfers);
    }

    function _recordDetailedActivityAt(
        uint256 ts,
        address card,
        address user,
        uint256 nftCount,
        uint256 mintAmount,
        uint256 burnAmount,
        uint256 transfers
    ) internal {
        LibStatsStorage.Layout storage s = LibStatsStorage.layout();
        uint256 hourIndex = ts / 3600;

        _updateHourlyStats(s.hourlyData[hourIndex], nftCount, mintAmount, burnAmount, transfers);
        _updateHourlyStats(s.cardHourlyData[card][hourIndex], nftCount, mintAmount, burnAmount, transfers);
        _updateHourlyStats(s.userHourlyData[user][hourIndex], nftCount, mintAmount, burnAmount, transfers);

        emit StatsUpdated(hourIndex, card, user);
    }

    function _updateHourlyStats(
        LibStatsStorage.HourlyStats storage st,
        uint256 nft,
        uint256 mint,
        uint256 burn,
        uint256 trans
    ) internal {
        if (!st.hasData) st.hasData = true;
        st.nftMinted += nft;
        st.tokenMinted += mint;
        st.tokenBurned += burn;
        st.transferCount += trans;
    }

    // --- view: expose raw data mappings via helpers (optional) ---
    function getHourlyData(uint256 hourIndex) external view returns (LibStatsStorage.HourlyStats memory) {
        return LibStatsStorage.layout().hourlyData[hourIndex];
    }

    function getCardHourlyData(address card, uint256 hourIndex) external view returns (LibStatsStorage.HourlyStats memory) {
        return LibStatsStorage.layout().cardHourlyData[card][hourIndex];
    }

    function getUserHourlyData(address user, uint256 hourIndex) external view returns (LibStatsStorage.HourlyStats memory) {
        return LibStatsStorage.layout().userHourlyData[user][hourIndex];
    }

    function getAggregatedStats(
        uint8 mode,
        address account,
        uint256 startTimestamp,
        uint256 endTimestamp
    ) public view returns (AggregatedStats memory stats) {
        if (endTimestamp < startTimestamp) return stats;

        uint256 startHour = startTimestamp / 3600;
        uint256 endHour = endTimestamp / 3600;
        if (endHour < startHour) return stats;

        require(endHour - startHour <= MAX_HOURS, "range too large");

        LibStatsStorage.Layout storage s = LibStatsStorage.layout();

        for (uint256 i = startHour; i <= endHour; i++) {
            LibStatsStorage.HourlyStats storage h;
            if (mode == 0) h = s.hourlyData[i];
            else if (mode == 1) h = s.cardHourlyData[account][i];
            else h = s.userHourlyData[account][i];

            if (h.hasData) {
                stats.totalNftMinted += h.nftMinted;
                stats.totalTokenMinted += h.tokenMinted;
                stats.totalTokenBurned += h.tokenBurned;
                stats.totalTransfers += h.transferCount;
            }
        }
    }

    function getStatsSince(
        uint8 mode,
        address account,
        uint256 startTimestamp
    ) external view returns (AggregatedStats memory) {
        return getAggregatedStats(mode, account, startTimestamp, block.timestamp);
    }

    // internal hook for other facets (TaskFacet) to record at a chosen timestamp
    function _recordDetailedActivityAtHook(
        uint256 ts,
        address card,
        address user,
        uint256 nftCount,
        uint256 mintAmount,
        uint256 burnAmount,
        uint256 transfers
    ) external {
        // This is meant to be called via delegatecall from diamond, so msg.sender is still the original caller.
        // We only allow the diamond owner (API gateway) to use it.
        LibDiamond.enforceIsContractOwner();
        _recordDetailedActivityAt(ts, card, user, nftCount, mintAmount, burnAmount, transfers);
    }
}
