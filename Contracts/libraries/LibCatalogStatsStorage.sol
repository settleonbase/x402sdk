// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library LibCatalogStatsStorage {
    bytes32 internal constant STORAGE_POSITION = keccak256("beamio.catalog.stats.storage.v1");

    struct HourlyCatalogStats {
        uint256 collectionsCreated;   // 新建卡集合数量
        uint256 metaUpdated;          // 卡资料修改次数
        uint256 activated;            // 上架/启用次数
        uint256 deactivated;          // 下架/禁用次数
        bool hasData;
    }

    struct Layout {
        // 全局维度
        mapping(uint256 => HourlyCatalogStats) hourly;
        // creator 维度
        mapping(address => mapping(uint256 => HourlyCatalogStats)) creatorHourly;
        // type 维度
        mapping(uint8 => mapping(uint256 => HourlyCatalogStats)) typeHourly;
    }

    function layout() internal pure returns (Layout storage l) {
        bytes32 slot = STORAGE_POSITION;
        assembly { l.slot := slot }
    }
}
