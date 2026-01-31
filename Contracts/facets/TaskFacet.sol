// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {LibDiamond} from "../libraries/LibDiamond.sol";
import {LibTaskStorage} from "../libraries/LibTaskStorage.sol";
import {LibStatsStorage} from "../libraries/LibStatsStorage.sol";

contract TaskFacet {
    // --- events (保持与你原来一致) ---
    event TaskCreated(uint256 indexed taskId, address indexed collection, uint256 pId);
    event TaskFinalized(uint256 indexed taskId);

    event CardWhitelistAdded(address indexed card, address indexed user);
    event CardWhitelistRemoved(address indexed card, address indexed user);

    event StatsUpdated(uint256 indexed hourIndex, address indexed card, address indexed user);

    // --- ✅ whitelist: 外部接口（和原来一致） ---
    function addCardWhitelist(address card, address user) external {
        LibDiamond.enforceIsContractOwner();
        _addCardWhitelist(card, user);
    }

    function addCardWhitelistBatch(address card, address[] calldata users) external {
        LibDiamond.enforceIsContractOwner();
        for (uint256 i = 0; i < users.length; i++) _addCardWhitelist(card, users[i]);
    }

    function removeCardWhitelist(address card, address user) external {
        LibDiamond.enforceIsContractOwner();
        _removeCardWhitelist(card, user);
    }

    function removeCardWhitelistBatch(address card, address[] calldata users) external {
        LibDiamond.enforceIsContractOwner();
        for (uint256 i = 0; i < users.length; i++) _removeCardWhitelist(card, users[i]);
    }

    function getCardWhitelist(address card) external view returns (address[] memory) {
        return LibTaskStorage.layout().cardWhitelist[card];
    }

    function getCardWhitelistPaged(address card, uint256 offset, uint256 limit) external view returns (address[] memory) {
        LibTaskStorage.Layout storage t = LibTaskStorage.layout();
        uint256 total = t.cardWhitelist[card].length;
        if (offset >= total) return new address[](0);

        uint256 end = offset + limit;
        if (end > total) end = total;

        address[] memory page = new address[](end - offset);
        for (uint256 i = 0; i < page.length; i++) page[i] = t.cardWhitelist[card][offset + i];
        return page;
    }

    function getCardWhitelistCount(address card) external view returns (uint256) {
        return LibTaskStorage.layout().cardWhitelist[card].length;
    }

    function isCardWhitelisted(address card, address user) external view returns (bool) {
        return LibTaskStorage.layout().isCardWhitelisted[card][user];
    }

    // --- ✅ task sync（和原来一致） ---
    function syncCreateTask(
        address[] calldata admins,
        address collection,
        uint256 pId,
        bytes4 sel,
        address target,
        uint256 v1,
        uint256 v2,
        uint256 v3,
        uint256 current,
        uint256 required
    ) external {
        LibDiamond.enforceIsContractOwner();
        LibTaskStorage.Layout storage s = LibTaskStorage.layout();

        uint256 taskId = s.allTasks.length;

        s.allTasks.push(
            LibTaskStorage.Task({
                mainnetCollection: collection,
                proposalId: pId,
                selector: sel,
                target: target,
                v1: v1,
                v2: v2,
                v3: v3,
                currentApprovals: current,
                requiredApprovals: required,
                isExecuted: false,
                isActive: true,
                timestamp: block.timestamp
            })
        );

        // 保存管理员列表（用于 executed 时清理）
        s.taskAdmins[taskId] = admins;

        for (uint256 i = 0; i < admins.length; i++) {
            _addToPending(admins[i], taskId);
        }

        emit TaskCreated(taskId, collection, pId);
    }

    function syncUpdateStatus(
        uint256 taskId,
        uint256 newCurrent,
        bool executed,
        address signer
    ) external {
        LibDiamond.enforceIsContractOwner();
        LibTaskStorage.Layout storage s = LibTaskStorage.layout();

        require(taskId < s.allTasks.length, "invalid taskId");
        LibTaskStorage.Task storage t = s.allTasks[taskId];
        require(t.isActive, "task not active");

        // 防止同一个 signer 重复上报
        require(!s.hasUserApproved[taskId][signer], "already approved");

        t.currentApprovals = newCurrent;
        t.isExecuted = executed;

        s.hasUserApproved[taskId][signer] = true;
        _removeFromPending(signer, taskId);

        if (executed) {
            t.isActive = false;

            // executed 时把所有管理员 pending 都清掉
            address[] storage admins = s.taskAdmins[taskId];
            for (uint256 i = 0; i < admins.length; i++) {
                _removeFromPending(admins[i], taskId);
            }

            // ✅ 自动写 stats / 同步 whitelist
            _autoRecordStatsFromTask(t);

            emit TaskFinalized(taskId);
        }
    }

    // --- stats (从任务自动转译) ---

    function _autoRecordStatsFromTask(LibTaskStorage.Task storage t) internal {
        uint256 ts = t.timestamp;

        if (t.selector == 0x6e9f167e) {
            // mintMemberCard
            _recordDetailedActivityAt(ts, t.mainnetCollection, t.target, 1, 0, 0, 1);
        } else if (t.selector == 0x40c10f19) {
            // mintPoints
            _recordDetailedActivityAt(ts, t.mainnetCollection, t.target, 0, t.v1, 0, 1);
        } else if (t.selector == 0x276639b5) {
            // mintCardAndPoints
            _recordDetailedActivityAt(ts, t.mainnetCollection, t.target, t.v1 > 0 ? 1 : 0, t.v3, 0, 1);
        } else if (t.selector == 0xe2316652) {
            // setWhitelist: v1 == 1 加白；否则移除
            if (t.v1 == 1) _addCardWhitelist(t.mainnetCollection, t.target);
            else _removeCardWhitelist(t.mainnetCollection, t.target);
        }
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

    // --- 用户待办 ---

    function getMyPendingTasks(address user) external view returns (LibTaskStorage.Task[] memory) {
        LibTaskStorage.Layout storage s = LibTaskStorage.layout();
        uint256[] storage ids = s.userPendingTasks[user];

        LibTaskStorage.Task[] memory list = new LibTaskStorage.Task[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            list[i] = s.allTasks[ids[i]];
        }
        return list;
    }

    // expose tasks array length / task getter (optional convenience)
    function getTaskCount() external view returns (uint256) {
        return LibTaskStorage.layout().allTasks.length;
    }

    function getTask(uint256 taskId) external view returns (LibTaskStorage.Task memory) {
        LibTaskStorage.Layout storage s = LibTaskStorage.layout();
        require(taskId < s.allTasks.length, "invalid taskId");
        return s.allTasks[taskId];
    }

    // --- internal helpers: pending ---

    function _addToPending(address user, uint256 taskId) internal {
        LibTaskStorage.Layout storage s = LibTaskStorage.layout();
        if (s.isPendingForUser[taskId][user]) return;

        s.isPendingForUser[taskId][user] = true;
        s.userTaskPos[taskId][user] = s.userPendingTasks[user].length;
        s.userPendingTasks[user].push(taskId);
    }

    function _removeFromPending(address user, uint256 taskId) internal {
        LibTaskStorage.Layout storage s = LibTaskStorage.layout();
        if (!s.isPendingForUser[taskId][user]) return;

        uint256[] storage tasks = s.userPendingTasks[user];
        uint256 pos = s.userTaskPos[taskId][user];

        s.isPendingForUser[taskId][user] = false;

        if (tasks.length == 0) {
            delete s.userTaskPos[taskId][user];
            return;
        }

        if (pos < tasks.length && tasks[pos] == taskId) {
            uint256 lastTaskId = tasks[tasks.length - 1];
            tasks[pos] = lastTaskId;
            s.userTaskPos[lastTaskId][user] = pos;
            tasks.pop();
        }

        delete s.userTaskPos[taskId][user];
    }

    // --- internal helpers: whitelist ---

    function _addCardWhitelist(address card, address user) internal {
        require(card != address(0), "card=0");
        require(user != address(0), "user=0");

        LibTaskStorage.Layout storage s = LibTaskStorage.layout();
        if (s.isCardWhitelisted[card][user]) return;

        s.cardWhitelist[card].push(user);
        s.cardWhitelistIndex[card][user] = s.cardWhitelist[card].length; // index+1
        s.isCardWhitelisted[card][user] = true;

        emit CardWhitelistAdded(card, user);
    }

    function _removeCardWhitelist(address card, address user) internal {
        LibTaskStorage.Layout storage s = LibTaskStorage.layout();
        if (!s.isCardWhitelisted[card][user]) return;

        uint256 idx1 = s.cardWhitelistIndex[card][user]; // index+1
        if (idx1 == 0) {
            // defensive
            s.isCardWhitelisted[card][user] = false;
            return;
        }

        uint256 idx = idx1 - 1;
        address[] storage arr = s.cardWhitelist[card];

        uint256 last = arr.length - 1;
        if (idx != last) {
            address lastAddr = arr[last];
            arr[idx] = lastAddr;
            s.cardWhitelistIndex[card][lastAddr] = idx + 1;
        }

        arr.pop();

        delete s.cardWhitelistIndex[card][user];
        s.isCardWhitelisted[card][user] = false;

        emit CardWhitelistRemoved(card, user);
    }
}
