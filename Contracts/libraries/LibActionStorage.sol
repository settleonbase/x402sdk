// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library LibActionStorage {
    bytes32 internal constant STORAGE_POSITION = keccak256("beamio.action.storage.v1");

    // token 动作类型（你也可以扩展更多 action）
    uint8 internal constant ACTION_TOKEN_MINT = 1;
    uint8 internal constant ACTION_TOKEN_BURN = 2;
    uint8 internal constant ACTION_TOKEN_TRANSFER = 3;

    struct Action {
        uint8 actionType;     // 1 mint, 2 burn, 3 transfer
        address card;         // card/collection address
        address from;         // mint: 0, burn/transfer: from
        address to;           // burn: 0, mint/transfer: to
        uint256 amount;       // token amount (points)
        uint256 timestamp;    // used for hourIndex
    }

    struct ActionMeta {
        string title;
        string note;

        uint256 tax;
        uint256 tip;
        uint256 beamioFee1;
        uint256 beamioFee2;
        uint256 cardServiceFee;

        // afterTatch（创建后可修改）
        string afterTatchNoteByFrom;
        string afterTatchNoteByTo;
        string afterTatchNoteByCardOwner;
    }

    struct Layout {
        Action[] allActions;                       // actionId == index
        mapping(uint256 => ActionMeta) metaById;   // actionId => meta

        // ✅ indexes for paging
        mapping(address => uint256[]) cardActions; // card => [actionId...]
        mapping(address => uint256[]) userActions; // user => [actionId...]
    }

    function layout() internal pure returns (Layout storage l) {
        bytes32 slot = STORAGE_POSITION;
        assembly { l.slot := slot }
    }
}
