// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {LibDiamond} from "../libraries/LibDiamond.sol";

contract OwnershipFacet {
    function owner() external view returns (address) {
        return LibDiamond.contractOwner();
    }

    function transferOwnership(address newOwner) external {
        LibDiamond.enforceIsContractOwner();
        require(newOwner != address(0), "owner=0");
        LibDiamond.setContractOwner(newOwner);
    }
}
