// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library LibStatsStorage {
    bytes32 internal constant STORAGE_POSITION = keccak256("beamio.stats.storage.v1");

    struct HourlyStats {
        uint256 nftMinted;
        uint256 tokenMinted;
        uint256 tokenBurned;
        uint256 transferCount;
        bool hasData;
    }

    struct Layout {
        mapping(uint256 => HourlyStats) hourlyData;
        mapping(address => mapping(uint256 => HourlyStats)) cardHourlyData;
        mapping(address => mapping(uint256 => HourlyStats)) userHourlyData;
    }

    function layout() internal pure returns (Layout storage l) {
        bytes32 slot = STORAGE_POSITION;
        assembly { l.slot := slot }
    }
}
