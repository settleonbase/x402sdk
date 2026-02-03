// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library RedeemStorage {
    // keccak256("beamio.redeem.storage.v1")
    bytes32 internal constant SLOT =
        0x5c6c7c4d63bff9f08a0e7cb3e2e53a2e47b69f7c9f1f6b7c4c9a6e1f8e2d9a11;

    struct Redeem {
        uint128 points6;
        uint64  tokenId;   // >= 1e8 fits in uint64
        uint32  tokenAmt;  // ERC1155 amount
        uint32  attr;
        bool active;
    }

    struct Layout {
        mapping(bytes32 => Redeem) redeems;
    }

    function layout() internal pure returns (Layout storage l) {
        bytes32 slot = SLOT;
        assembly { l.slot := slot }
    }
}

contract RedeemModule {
    using RedeemStorage for RedeemStorage.Layout;

    event RedeemCreated(bytes32 indexed hash, uint256 points6, uint256 attr, uint256 tokenId, uint256 tokenAmt);
    event RedeemCancelled(bytes32 indexed hash);
    event RedeemConsumed(bytes32 indexed hash, address indexed user);

    // ===== single =====
    function createRedeem(
        bytes32 hash,
        uint256 points6,
        uint256 attr,
        uint256 tokenId,
        uint256 tokenAmt
    ) external {
        require(hash != bytes32(0), "hash=0");

        RedeemStorage.Layout storage l = RedeemStorage.layout();
        require(!l.redeems[hash].active, "exists");

        if (tokenId != 0) require(tokenAmt != 0, "amt=0");

        l.redeems[hash] = RedeemStorage.Redeem({
            points6: uint128(points6),
            tokenId: uint64(tokenId),
            tokenAmt: uint32(tokenAmt),
            attr: uint32(attr),
            active: true
        });

        emit RedeemCreated(hash, points6, attr, tokenId, tokenAmt);
    }

    // ===== batch (same payload, multiple hashes) =====
    function createRedeemBatch(
        bytes32[] calldata hashes,
        uint256 points6,
        uint256 attr,
        uint256 tokenId,
        uint256 tokenAmt
    ) external {
        uint256 n = hashes.length;
        require(n != 0, "len=0");
        if (tokenId != 0) require(tokenAmt != 0, "amt=0");

        RedeemStorage.Layout storage l = RedeemStorage.layout();

        for (uint256 i = 0; i < n; i++) {
            bytes32 h = hashes[i];
            require(h != bytes32(0), "hash=0");
            require(!l.redeems[h].active, "exists");

            l.redeems[h] = RedeemStorage.Redeem({
                points6: uint128(points6),
                tokenId: uint64(tokenId),
                tokenAmt: uint32(tokenAmt),
                attr: uint32(attr),
                active: true
            });

            emit RedeemCreated(h, points6, attr, tokenId, tokenAmt);
        }
    }

    // cancel: string
    function cancelRedeem(string calldata code) external {
        bytes32 hash = keccak256(bytes(code));

        RedeemStorage.Layout storage l = RedeemStorage.layout();
        RedeemStorage.Redeem storage r = l.redeems[hash];

        require(r.active, "inactive");
        r.active = false;

        emit RedeemCancelled(hash);
    }

    // consume: string
    function consumeRedeem(string calldata code, address to)
        external
        returns (uint256 points6, uint256 attr, uint256 tokenId, uint256 tokenAmt)
    {
        bytes32 hash = keccak256(bytes(code));

        RedeemStorage.Layout storage l = RedeemStorage.layout();
        RedeemStorage.Redeem storage r = l.redeems[hash];

        require(r.active, "invalid redeem");
        r.active = false;

        emit RedeemConsumed(hash, to);
        return (r.points6, r.attr, r.tokenId, r.tokenAmt);
    }
}
