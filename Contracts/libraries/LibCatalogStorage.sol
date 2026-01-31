// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library LibCatalogStorage {
    bytes32 internal constant STORAGE_POSITION = keccak256("beamio.catalog.storage.v1");

    struct CardMeta {
        address card;        // BeamioUserCard 合约地址（或 collection 地址）
        address creator;     // 创建者（谁拥有这个卡集合）

        string name;         // 卡名称（testnet 允许更全记录）
        string description;  // 卡介绍
        string uri;          // createCardCollection(uri) 的 uri

        uint8 currency;      // BeamioCurrency.CurrencyType (uint8 存)
        uint256 priceE18;    // pointsUnitPriceInCurrencyE18

        uint8 cardType;      // 自定义卡种/等级（你可以自己定义枚举）
        uint64 saleStart;    // 可选：售卖开始时间（0 = 不限制）
        uint64 saleEnd;      // 可选：售卖结束时间（0 = 不限制）

        bool active;         // 是否启用/在售
        uint256 createdAt;   // 记录创建时间（可用于展示）
        uint256 updatedAt;
    }

    struct Layout {
        // card => meta
        mapping(address => CardMeta) meta;
        // card => exists
        mapping(address => bool) exists;

        // 全量枚举
        address[] allCards;
        mapping(address => uint256) allCardIndex; // index+1

        // creator 枚举
        mapping(address => address[]) creatorCards;
        mapping(address => mapping(address => uint256)) creatorCardIndex; // creator => card => index+1

        // type 枚举
        mapping(uint8 => address[]) typeCards;
        mapping(uint8 => mapping(address => uint256)) typeCardIndex; // type => card => index+1
    }

    function layout() internal pure returns (Layout storage l) {
        bytes32 slot = STORAGE_POSITION;
        assembly { l.slot := slot }
    }
}
