// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IDiamondCut} from "./interfaces/IDiamondCut.sol";
import {IDiamondLoupe} from "./interfaces/IDiamondLoupe.sol";
import {IERC165} from "./interfaces/IERC165.sol";
import {LibDiamond} from "./libraries/LibDiamond.sol";

contract BeamioIndexerDiamond {
    constructor(address initialOwner, address diamondCutFacet) {
        require(initialOwner != address(0), "owner=0");
        require(diamondCutFacet != address(0), "cutFacet=0");

        LibDiamond.setContractOwner(initialOwner);

        // 1. Declare and initialize the array
        bytes4[] memory selectors = new bytes4[](1); 
        
        // 2. Assign the selector
        selectors[0] = IDiamondCut.diamondCut.selector;

        // 3. Add functions to the diamond
        LibDiamond.addFunctions(diamondCutFacet, selectors);

        // ERC165 interface support
        LibDiamond.setSupportedInterface(type(IERC165).interfaceId, true);
        LibDiamond.setSupportedInterface(type(IDiamondCut).interfaceId, true);
        LibDiamond.setSupportedInterface(type(IDiamondLoupe).interfaceId, true);
    }

    // Find facet for function that is called and execute the
    // function if a facet is found and return any value.
    fallback() external payable {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        address facet = ds.selectorToFacetAndPosition[msg.sig].facetAddress;
        require(facet != address(0), "Diamond: fn not found");

        assembly {
            // copy calldata
            calldatacopy(0, 0, calldatasize())
            // delegatecall to facet
            let result := delegatecall(gas(), facet, 0, calldatasize(), 0, 0)
            // copy returndata
            returndatacopy(0, 0, returndatasize())
            // return / revert
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    receive() external payable {}
}
