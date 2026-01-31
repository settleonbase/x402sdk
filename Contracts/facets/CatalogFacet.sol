// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {LibDiamond} from "../libraries/LibDiamond.sol";
import {LibCatalogStorage} from "../libraries/LibCatalogStorage.sol";
import {LibCatalogStatsStorage} from "../libraries/LibCatalogStatsStorage.sol";

contract CatalogFacet {
    // 和 TaskIndexer 一样：限制时间范围，避免 OOG（默认最多 90 天）
    uint256 public constant MAX_HOURS = 2160;

    // --- events ---
    event CardRegistered(address indexed card, address indexed creator, uint8 indexed cardType);
    event CardMetaUpdated(address indexed card, address indexed operator);
    event CardActiveChanged(address indexed card, bool active);

    event CatalogStatsUpdated(uint256 indexed hourIndex, address indexed creator, uint8 indexed cardType);

    // --- stats return type ---
    struct AggregatedCatalogStats {
        uint256 totalCreated;
        uint256 totalMetaUpdated;
        uint256 totalActivated;
        uint256 totalDeactivated;
    }

    // --- calldata inputs: 避免 stack too deep ---
    struct RegisterCardInput {
        address card;
        address creator;
        string name;
        string description;
        string uri;
        uint8 currency;
        uint256 priceE18;
        uint8 cardType;
        uint64 saleStart;
        uint64 saleEnd;
        uint256 ts; // 0 => block.timestamp
    }

    struct UpdateCardMetaInput {
        address card;
        string name;
        string description;
        string uri;
        uint8 currency;
        uint256 priceE18;
        uint8 newCardType;
        uint64 saleStart;
        uint64 saleEnd;
        uint256 ts; // 0 => block.timestamp
    }

    struct SetActiveInput {
        address card;
        bool active;
        uint256 ts; // 0 => block.timestamp
    }

    // =========================
    //  Catalog: write (onlyOwner)
    // =========================

    /**
     * @notice 记录“创建卡集合”的辅助信息（testnet 可记录更多 string）
     * @dev 由 API 在 createCardCollection/createCardCollectionFor 成功后调用
     */
    function registerCard(RegisterCardInput calldata in_) external {
        LibDiamond.enforceIsContractOwner();

        require(in_.card != address(0), "card=0");
        require(in_.creator != address(0), "creator=0");

        uint256 useTs = in_.ts == 0 ? block.timestamp : in_.ts;

        LibCatalogStorage.Layout storage c = LibCatalogStorage.layout();
        require(!c.exists[in_.card], "card exists");

        _writeNewMeta(c, in_, useTs);
        _indexNewCard(c, in_.card, in_.creator, in_.cardType);

        // 写分时 stats（原子）
        _recordCatalogActivityAt(useTs, in_.creator, in_.cardType, 1, 0, 0, 0);

        emit CardRegistered(in_.card, in_.creator, in_.cardType);
    }

    function _writeNewMeta(
        LibCatalogStorage.Layout storage c,
        RegisterCardInput calldata in_,
        uint256 useTs
    ) internal {
        LibCatalogStorage.CardMeta storage m = c.meta[in_.card];

        m.card = in_.card;
        m.creator = in_.creator;
        m.name = in_.name;
        m.description = in_.description;
        m.uri = in_.uri;
        m.currency = in_.currency;
        m.priceE18 = in_.priceE18;
        m.cardType = in_.cardType;
        m.saleStart = in_.saleStart;
        m.saleEnd = in_.saleEnd;
        m.active = true;
        m.createdAt = useTs;
        m.updatedAt = useTs;

        c.exists[in_.card] = true;
    }

    function _indexNewCard(
        LibCatalogStorage.Layout storage c,
        address card,
        address creator,
        uint8 cardType
    ) internal {
        // all
        c.allCards.push(card);
        c.allCardIndex[card] = c.allCards.length; // index+1

        // creator
        c.creatorCards[creator].push(card);
        c.creatorCardIndex[creator][card] = c.creatorCards[creator].length;

        // type
        c.typeCards[cardType].push(card);
        c.typeCardIndex[cardType][card] = c.typeCards[cardType].length;
    }

    /**
     * @notice 修改卡资料（testnet 允许更全记录）
     */
    function updateCardMeta(UpdateCardMetaInput calldata in_) external {
        LibDiamond.enforceIsContractOwner();

        LibCatalogStorage.Layout storage c = LibCatalogStorage.layout();
        require(c.exists[in_.card], "card not exist");

        uint256 useTs = in_.ts == 0 ? block.timestamp : in_.ts;

        LibCatalogStorage.CardMeta storage m = c.meta[in_.card];

        // 如果 cardType 变更，需要更新 type 枚举索引
        if (m.cardType != in_.newCardType) {
            _moveTypeIndex(c, in_.card, m.cardType, in_.newCardType);
            m.cardType = in_.newCardType;
        }

        m.name = in_.name;
        m.description = in_.description;
        m.uri = in_.uri;
        m.currency = in_.currency;
        m.priceE18 = in_.priceE18;
        m.saleStart = in_.saleStart;
        m.saleEnd = in_.saleEnd;
        m.updatedAt = useTs;

        _recordCatalogActivityAt(useTs, m.creator, m.cardType, 0, 1, 0, 0);

        emit CardMetaUpdated(in_.card, msg.sender);
    }

    /**
     * @notice 上下架/启用开关
     */
    function setCardActive(SetActiveInput calldata in_) external {
        LibDiamond.enforceIsContractOwner();

        LibCatalogStorage.Layout storage c = LibCatalogStorage.layout();
        require(c.exists[in_.card], "card not exist");

        uint256 useTs = in_.ts == 0 ? block.timestamp : in_.ts;

        LibCatalogStorage.CardMeta storage m = c.meta[in_.card];
        if (m.active == in_.active) return;

        m.active = in_.active;
        m.updatedAt = useTs;

        if (in_.active) _recordCatalogActivityAt(useTs, m.creator, m.cardType, 0, 0, 1, 0);
        else _recordCatalogActivityAt(useTs, m.creator, m.cardType, 0, 0, 0, 1);

        emit CardActiveChanged(in_.card, in_.active);
    }

    // =========================
    //  Catalog: read
    // =========================

    function getCardMeta(address card) external view returns (LibCatalogStorage.CardMeta memory) {
        return LibCatalogStorage.layout().meta[card];
    }

    function cardExists(address card) external view returns (bool) {
        return LibCatalogStorage.layout().exists[card];
    }

    function getAllCardsCount() external view returns (uint256) {
        return LibCatalogStorage.layout().allCards.length;
    }

    function getAllCardsPaged(uint256 offset, uint256 limit) external view returns (address[] memory page) {
        LibCatalogStorage.Layout storage c = LibCatalogStorage.layout();
        uint256 total = c.allCards.length;
        if (offset >= total) return new address[](0);

        uint256 end = offset + limit;
        if (end > total) end = total;

        page = new address[](end - offset);
        for (uint256 i = 0; i < page.length; i++) page[i] = c.allCards[offset + i];
    }

    function getCreatorCardsCount(address creator) external view returns (uint256) {
        return LibCatalogStorage.layout().creatorCards[creator].length;
    }

    function getCreatorCardsPaged(address creator, uint256 offset, uint256 limit) external view returns (address[] memory page) {
        LibCatalogStorage.Layout storage c = LibCatalogStorage.layout();
        uint256 total = c.creatorCards[creator].length;
        if (offset >= total) return new address[](0);

        uint256 end = offset + limit;
        if (end > total) end = total;

        page = new address[](end - offset);
        for (uint256 i = 0; i < page.length; i++) page[i] = c.creatorCards[creator][offset + i];
    }

    function getTypeCardsCount(uint8 cardType) external view returns (uint256) {
        return LibCatalogStorage.layout().typeCards[cardType].length;
    }

    function getTypeCardsPaged(uint8 cardType, uint256 offset, uint256 limit) external view returns (address[] memory page) {
        LibCatalogStorage.Layout storage c = LibCatalogStorage.layout();
        uint256 total = c.typeCards[cardType].length;
        if (offset >= total) return new address[](0);

        uint256 end = offset + limit;
        if (end > total) end = total;

        page = new address[](end - offset);
        for (uint256 i = 0; i < page.length; i++) page[i] = c.typeCards[cardType][offset + i];
    }

    // =========================
    //  Catalog stats: aggregate
    // =========================

    /**
     * @notice mode=0 全局, mode=1 按 creator, mode=2 按 cardType
     */
    function getCatalogAggregatedStats(
        uint8 mode,
        address account,
        uint8 cardType,
        uint256 startTimestamp,
        uint256 endTimestamp
    ) public view returns (AggregatedCatalogStats memory stats) {
        if (endTimestamp < startTimestamp) return stats;

        uint256 startHour = startTimestamp / 3600;
        uint256 endHour = endTimestamp / 3600;
        if (endHour < startHour) return stats;

        require(endHour - startHour <= MAX_HOURS, "range too large");

        LibCatalogStatsStorage.Layout storage s = LibCatalogStatsStorage.layout();

        for (uint256 i = startHour; i <= endHour; i++) {
            LibCatalogStatsStorage.HourlyCatalogStats storage h;
            if (mode == 0) h = s.hourly[i];
            else if (mode == 1) h = s.creatorHourly[account][i];
            else h = s.typeHourly[cardType][i];

            if (h.hasData) {
                stats.totalCreated += h.collectionsCreated;
                stats.totalMetaUpdated += h.metaUpdated;
                stats.totalActivated += h.activated;
                stats.totalDeactivated += h.deactivated;
            }
        }
    }

    function getCatalogStatsSince(
        uint8 mode,
        address account,
        uint8 cardType,
        uint256 startTimestamp
    ) external view returns (AggregatedCatalogStats memory) {
        return getCatalogAggregatedStats(mode, account, cardType, startTimestamp, block.timestamp);
    }

    function getCatalogHourly(uint256 hourIndex) external view returns (LibCatalogStatsStorage.HourlyCatalogStats memory) {
        return LibCatalogStatsStorage.layout().hourly[hourIndex];
    }

    function getCatalogCreatorHourly(address creator, uint256 hourIndex)
        external
        view
        returns (LibCatalogStatsStorage.HourlyCatalogStats memory)
    {
        return LibCatalogStatsStorage.layout().creatorHourly[creator][hourIndex];
    }

    function getCatalogTypeHourly(uint8 cardType, uint256 hourIndex)
        external
        view
        returns (LibCatalogStatsStorage.HourlyCatalogStats memory)
    {
        return LibCatalogStatsStorage.layout().typeHourly[cardType][hourIndex];
    }

    // =========================
    //  internal helpers
    // =========================

    function _recordCatalogActivityAt(
        uint256 ts,
        address creator,
        uint8 cardType,
        uint256 created,
        uint256 updated,
        uint256 actOn,
        uint256 actOff
    ) internal {
        LibCatalogStatsStorage.Layout storage s = LibCatalogStatsStorage.layout();
        uint256 hourIndex = ts / 3600;

        _update(s.hourly[hourIndex], created, updated, actOn, actOff);
        _update(s.creatorHourly[creator][hourIndex], created, updated, actOn, actOff);
        _update(s.typeHourly[cardType][hourIndex], created, updated, actOn, actOff);

        emit CatalogStatsUpdated(hourIndex, creator, cardType);
    }

    function _update(
        LibCatalogStatsStorage.HourlyCatalogStats storage st,
        uint256 created,
        uint256 updated,
        uint256 actOn,
        uint256 actOff
    ) internal {
        if (!st.hasData) st.hasData = true;
        st.collectionsCreated += created;
        st.metaUpdated += updated;
        st.activated += actOn;
        st.deactivated += actOff;
    }

    function _moveTypeIndex(
        LibCatalogStorage.Layout storage c,
        address card,
        uint8 oldType,
        uint8 newType
    ) internal {
        // remove from old type array (swap & pop)
        uint256 idx1 = c.typeCardIndex[oldType][card];
        if (idx1 != 0) {
            uint256 idx = idx1 - 1;
            address[] storage arr = c.typeCards[oldType];
            uint256 last = arr.length - 1;

            if (idx != last) {
                address lastCard = arr[last];
                arr[idx] = lastCard;
                c.typeCardIndex[oldType][lastCard] = idx + 1;
            }
            arr.pop();
            delete c.typeCardIndex[oldType][card];
        }

        // add to new type
        c.typeCards[newType].push(card);
        c.typeCardIndex[newType][card] = c.typeCards[newType].length;
    }
}
