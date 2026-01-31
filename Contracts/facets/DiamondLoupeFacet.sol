// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IDiamondLoupe} from "../interfaces/IDiamondLoupe.sol";
import {IERC165} from "../interfaces/IERC165.sol";
import {LibDiamond} from "../libraries/LibDiamond.sol";

contract DiamondLoupeFacet is IDiamondLoupe {
    function supportsInterface(bytes4 interfaceId) external view override returns (bool) {
        return LibDiamond.supportsInterface(interfaceId);
    }

    function facets() external view override returns (Facet[] memory facets_) {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();

        facets_ = new Facet[](ds.facetAddresses.length);
        for (uint256 i = 0; i < ds.facetAddresses.length; i++) {
            address facetAddr = ds.facetAddresses[i];
            facets_[i].facetAddress = facetAddr;
            facets_[i].functionSelectors = ds.facetFunctionSelectors[facetAddr].functionSelectors;
        }
    }

    // Convenience: all selectors across facets (flatten)
    function facetFunctionSelectors() external view override returns (bytes4[] memory selectors_) {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        uint256 total;

        for (uint256 i = 0; i < ds.facetAddresses.length; i++) {
            total += ds.facetFunctionSelectors[ds.facetAddresses[i]].functionSelectors.length;
        }

        selectors_ = new bytes4[](total);
        uint256 k;
        for (uint256 i = 0; i < ds.facetAddresses.length; i++) {
            bytes4[] storage sels = ds.facetFunctionSelectors[ds.facetAddresses[i]].functionSelectors;
            for (uint256 j = 0; j < sels.length; j++) {
                selectors_[k++] = sels[j];
            }
        }
    }

    function facetFunctionSelectors(address _facet) external view override returns (bytes4[] memory selectors_) {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        selectors_ = ds.facetFunctionSelectors[_facet].functionSelectors;
    }

    function facetAddresses() external view override returns (address[] memory facetAddresses_) {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        facetAddresses_ = ds.facetAddresses;
    }

    function facetAddress(bytes4 _selector) external view override returns (address facetAddress_) {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        facetAddress_ = ds.selectorToFacetAndPosition[_selector].facetAddress;
    }
}
