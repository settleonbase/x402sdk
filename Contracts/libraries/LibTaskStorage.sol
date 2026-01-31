// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library LibTaskStorage {
    bytes32 internal constant STORAGE_POSITION = keccak256("beamio.task.storage.v1");

    struct Task {
        address mainnetCollection;
        uint256 proposalId;
        bytes4 selector;
        address target;
        uint256 v1;
        uint256 v2;
        uint256 v3;
        uint256 currentApprovals;
        uint256 requiredApprovals;
        bool isExecuted;
        bool isActive;
        uint256 timestamp;
    }

    struct Layout {
        Task[] allTasks;

        // pending
        mapping(address => uint256[]) userPendingTasks;
        mapping(uint256 => mapping(address => uint256)) userTaskPos; // taskId => user => index in userPendingTasks[user]
        mapping(uint256 => mapping(address => bool)) hasUserApproved;
        mapping(uint256 => mapping(address => bool)) isPendingForUser;
        mapping(uint256 => address[]) taskAdmins;

        // whitelist enumerable
        mapping(address => address[]) cardWhitelist;
        mapping(address => mapping(address => bool)) isCardWhitelisted;
        mapping(address => mapping(address => uint256)) cardWhitelistIndex; // index+1
    }

    function layout() internal pure returns (Layout storage l) {
        bytes32 slot = STORAGE_POSITION;
        assembly { l.slot := slot }
    }
}
