// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {LibDiamond} from "../libraries/LibDiamond.sol";
import {LibActionStorage} from "../libraries/LibActionStorage.sol";
import {LibStatsStorage} from "../libraries/LibStatsStorage.sol";

contract ActionFacet {
    event StatsUpdated(uint256 indexed hourIndex, address indexed card, address indexed user);

    event TokenActionSynced(
        uint256 indexed actionId,
        uint8 indexed actionType,
        address indexed card,
        address from,
        address to,
        uint256 amount
    );

    event AfterTatchNoteUpdated(uint256 indexed actionId);

    struct TokenActionInput {
        uint8 actionType;     // 1 mint, 2 burn, 3 transfer
        address card;
        address from;
        address to;
        uint256 amount;
        uint256 ts;           // 0 => block.timestamp

        // meta fields
        string title;
        string note;
        uint256 tax;
        uint256 tip;
        uint256 beamioFee1;
        uint256 beamioFee2;
        uint256 cardServiceFee;

        // afterTatch (can update later, but can also set on create)
        string afterTatchNoteByFrom;
        string afterTatchNoteByTo;
        string afterTatchNoteByCardOwner;
    }

    // ================
    //  Create (sync)
    // ================

    function syncTokenAction(TokenActionInput calldata in_) external returns (uint256 actionId) {
        LibDiamond.enforceIsContractOwner();

        require(in_.card != address(0), "card=0");
        require(in_.amount > 0, "amount=0");
        require(
            in_.actionType == LibActionStorage.ACTION_TOKEN_MINT ||
            in_.actionType == LibActionStorage.ACTION_TOKEN_BURN ||
            in_.actionType == LibActionStorage.ACTION_TOKEN_TRANSFER,
            "bad actionType"
        );

        if (in_.actionType == LibActionStorage.ACTION_TOKEN_MINT) {
            require(in_.to != address(0), "to=0");
        } else if (in_.actionType == LibActionStorage.ACTION_TOKEN_BURN) {
            require(in_.from != address(0), "from=0");
        } else {
            require(in_.from != address(0), "from=0");
            require(in_.to != address(0), "to=0");
        }

        uint256 useTs = in_.ts == 0 ? block.timestamp : in_.ts;

        LibActionStorage.Layout storage a = LibActionStorage.layout();
        actionId = a.allActions.length;

        // 1) write action
        a.allActions.push(
            LibActionStorage.Action({
                actionType: in_.actionType,
                card: in_.card,
                from: in_.from,
                to: in_.to,
                amount: in_.amount,
                timestamp: useTs
            })
        );

        // 2) write meta
        LibActionStorage.ActionMeta storage m = a.metaById[actionId];
        m.title = in_.title;
        m.note = in_.note;
        m.tax = in_.tax;
        m.tip = in_.tip;
        m.beamioFee1 = in_.beamioFee1;
        m.beamioFee2 = in_.beamioFee2;
        m.cardServiceFee = in_.cardServiceFee;
        m.afterTatchNoteByFrom = in_.afterTatchNoteByFrom;
        m.afterTatchNoteByTo = in_.afterTatchNoteByTo;
        m.afterTatchNoteByCardOwner = in_.afterTatchNoteByCardOwner;

        // ✅ 3) write paging indexes (card + users)
        _indexAction(a, actionId, in_.card, in_.actionType, in_.from, in_.to);

        // 4) write hourly stats (reuse existing LibStatsStorage)
        _recordTokenStats(useTs, in_.card, in_.actionType, in_.from, in_.to, in_.amount);

        emit TokenActionSynced(actionId, in_.actionType, in_.card, in_.from, in_.to, in_.amount);
    }

    function _indexAction(
        LibActionStorage.Layout storage a,
        uint256 actionId,
        address card,
        uint8 actionType,
        address from,
        address to
    ) internal {
        // card index
        a.cardActions[card].push(actionId);

        // user index
        if (actionType == LibActionStorage.ACTION_TOKEN_MINT) {
            a.userActions[to].push(actionId);
        } else if (actionType == LibActionStorage.ACTION_TOKEN_BURN) {
            a.userActions[from].push(actionId);
        } else {
            // transfer: record for both parties (avoid duplicates if same)
            a.userActions[from].push(actionId);
            if (to != from) a.userActions[to].push(actionId);
        }
    }

    function _recordTokenStats(
        uint256 ts,
        address card,
        uint8 actionType,
        address from,
        address to,
        uint256 amount
    ) internal {
        LibStatsStorage.Layout storage s = LibStatsStorage.layout();
        uint256 hourIndex = ts / 3600;

        if (actionType == LibActionStorage.ACTION_TOKEN_MINT) {
            _upd(s.hourlyData[hourIndex], 0, amount, 0, 1);
            _upd(s.cardHourlyData[card][hourIndex], 0, amount, 0, 1);
            _upd(s.userHourlyData[to][hourIndex], 0, amount, 0, 1);
            emit StatsUpdated(hourIndex, card, to);
        } else if (actionType == LibActionStorage.ACTION_TOKEN_BURN) {
            _upd(s.hourlyData[hourIndex], 0, 0, amount, 1);
            _upd(s.cardHourlyData[card][hourIndex], 0, 0, amount, 1);
            _upd(s.userHourlyData[from][hourIndex], 0, 0, amount, 1);
            emit StatsUpdated(hourIndex, card, from);
        } else {
            _upd(s.hourlyData[hourIndex], 0, 0, 0, 1);
            _upd(s.cardHourlyData[card][hourIndex], 0, 0, 0, 1);

            _upd(s.userHourlyData[from][hourIndex], 0, 0, 0, 1);
            emit StatsUpdated(hourIndex, card, from);

            if (to != address(0) && to != from) {
                _upd(s.userHourlyData[to][hourIndex], 0, 0, 0, 1);
                emit StatsUpdated(hourIndex, card, to);
            }
        }
    }

    function _upd(
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

    // ===========================
    //  afterTatch notes: updatable
    // ===========================

    function setAfterTatchNoteByFrom(uint256 actionId, string calldata note) external {
        LibDiamond.enforceIsContractOwner();
        _requireActionExists(actionId);
        LibActionStorage.layout().metaById[actionId].afterTatchNoteByFrom = note;
        emit AfterTatchNoteUpdated(actionId);
    }

    function setAfterTatchNoteByTo(uint256 actionId, string calldata note) external {
        LibDiamond.enforceIsContractOwner();
        _requireActionExists(actionId);
        LibActionStorage.layout().metaById[actionId].afterTatchNoteByTo = note;
        emit AfterTatchNoteUpdated(actionId);
    }

    function setAfterTatchNoteByCardOwner(uint256 actionId, string calldata note) external {
        LibDiamond.enforceIsContractOwner();
        _requireActionExists(actionId);
        LibActionStorage.layout().metaById[actionId].afterTatchNoteByCardOwner = note;
        emit AfterTatchNoteUpdated(actionId);
    }

    function setAfterTatchNotes(
        uint256 actionId,
        string calldata byFrom,
        string calldata byTo,
        string calldata byCardOwner
    ) external {
        LibDiamond.enforceIsContractOwner();
        _requireActionExists(actionId);

        LibActionStorage.ActionMeta storage m = LibActionStorage.layout().metaById[actionId];
        m.afterTatchNoteByFrom = byFrom;
        m.afterTatchNoteByTo = byTo;
        m.afterTatchNoteByCardOwner = byCardOwner;

        emit AfterTatchNoteUpdated(actionId);
    }

    // =========
    //  Read API
    // =========

    function getActionCount() external view returns (uint256) {
        return LibActionStorage.layout().allActions.length;
    }

    function getAction(uint256 actionId) external view returns (LibActionStorage.Action memory) {
        _requireActionExists(actionId);
        return LibActionStorage.layout().allActions[actionId];
    }

    function getActionMeta(uint256 actionId) external view returns (LibActionStorage.ActionMeta memory) {
        _requireActionExists(actionId);
        return LibActionStorage.layout().metaById[actionId];
    }

    function getActionWithMeta(uint256 actionId)
        external
        view
        returns (LibActionStorage.Action memory action_, LibActionStorage.ActionMeta memory meta_)
    {
        _requireActionExists(actionId);
        LibActionStorage.Layout storage a = LibActionStorage.layout();
        action_ = a.allActions[actionId];
        meta_ = a.metaById[actionId];
    }

    // ======================
    //  ✅ Card paging queries
    // ======================

    function getCardActionsCount(address card) external view returns (uint256) {
        return LibActionStorage.layout().cardActions[card].length;
    }

    function getCardActionIdsPaged(address card, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory page)
    {
        uint256[] storage ids = LibActionStorage.layout().cardActions[card];
        uint256 total = ids.length;
        if (offset >= total) return new uint256[](0);

        uint256 end = offset + limit;
        if (end > total) end = total;

        page = new uint256[](end - offset);
        for (uint256 i = 0; i < page.length; i++) page[i] = ids[offset + i];
    }

    function getCardActionsPaged(address card, uint256 offset, uint256 limit)
        external
        view
        returns (LibActionStorage.Action[] memory page)
    {
        uint256[] storage ids = LibActionStorage.layout().cardActions[card];
        uint256 total = ids.length;
        if (offset >= total) return new LibActionStorage.Action[](0);

        uint256 end = offset + limit;
        if (end > total) end = total;

        LibActionStorage.Layout storage a = LibActionStorage.layout();
        page = new LibActionStorage.Action[](end - offset);
        for (uint256 i = 0; i < page.length; i++) {
            page[i] = a.allActions[ids[offset + i]];
        }
    }

    // ======================
    //  ✅ User paging queries
    // ======================

    function getUserActionsCount(address user) external view returns (uint256) {
        return LibActionStorage.layout().userActions[user].length;
    }

    function getUserActionIdsPaged(address user, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory page)
    {
        uint256[] storage ids = LibActionStorage.layout().userActions[user];
        uint256 total = ids.length;
        if (offset >= total) return new uint256[](0);

        uint256 end = offset + limit;
        if (end > total) end = total;

        page = new uint256[](end - offset);
        for (uint256 i = 0; i < page.length; i++) page[i] = ids[offset + i];
    }

    function getUserActionsPaged(address user, uint256 offset, uint256 limit)
        external
        view
        returns (LibActionStorage.Action[] memory page)
    {
        uint256[] storage ids = LibActionStorage.layout().userActions[user];
        uint256 total = ids.length;
        if (offset >= total) return new LibActionStorage.Action[](0);

        uint256 end = offset + limit;
        if (end > total) end = total;

        LibActionStorage.Layout storage a = LibActionStorage.layout();
        page = new LibActionStorage.Action[](end - offset);
        for (uint256 i = 0; i < page.length; i++) {
            page[i] = a.allActions[ids[offset + i]];
        }
    }

    function _requireActionExists(uint256 actionId) internal view {
        require(actionId < LibActionStorage.layout().allActions.length, "invalid actionId");
    }
}
