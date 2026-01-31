// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IDiamondCut} from "../interfaces/IDiamondCut.sol";
import {IERC165} from "../interfaces/IERC165.sol";

library LibDiamond {
    bytes32 internal constant DIAMOND_STORAGE_POSITION = keccak256("beamio.diamond.storage.v1");

    struct FacetAddressAndPosition {
        address facetAddress;
        uint96 functionSelectorPosition;
    }

    struct FacetFunctionSelectors {
        bytes4[] functionSelectors;
        uint256 facetAddressPosition;
    }

    struct DiamondStorage {
        // selector => facet address & selector position
        mapping(bytes4 => FacetAddressAndPosition) selectorToFacetAndPosition;

        // facet address => selectors
        mapping(address => FacetFunctionSelectors) facetFunctionSelectors;

        // facet addresses
        address[] facetAddresses;

        // ERC165 support
        mapping(bytes4 => bool) supportedInterfaces;

        // owner
        address contractOwner;
    }

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    function diamondStorage() internal pure returns (DiamondStorage storage ds) {
        bytes32 slot = DIAMOND_STORAGE_POSITION;
        assembly { ds.slot := slot }
    }

    // --- ownership ---
    function setContractOwner(address _newOwner) internal {
        DiamondStorage storage ds = diamondStorage();
        address previous = ds.contractOwner;
        ds.contractOwner = _newOwner;
        emit OwnershipTransferred(previous, _newOwner);
    }

    function contractOwner() internal view returns (address) {
        return diamondStorage().contractOwner;
    }

    function enforceIsContractOwner() internal view {
        require(msg.sender == diamondStorage().contractOwner, "LibDiamond: must be owner");
    }

    // --- diamond cut ---
    function addFunctions(address _facet, bytes4[] memory _selectors) internal {
        require(_facet != address(0), "LibDiamond: facet=0");
        DiamondStorage storage ds = diamondStorage();

        uint256 selectorCount = ds.facetFunctionSelectors[_facet].functionSelectors.length;
        if (selectorCount == 0) {
            ds.facetFunctionSelectors[_facet].facetAddressPosition = ds.facetAddresses.length;
            ds.facetAddresses.push(_facet);
        }

        for (uint256 i = 0; i < _selectors.length; i++) {
            bytes4 sel = _selectors[i];
            require(ds.selectorToFacetAndPosition[sel].facetAddress == address(0), "LibDiamond: selector exists");

            ds.selectorToFacetAndPosition[sel] = FacetAddressAndPosition({
                facetAddress: _facet,
                functionSelectorPosition: uint96(ds.facetFunctionSelectors[_facet].functionSelectors.length)
            });

            ds.facetFunctionSelectors[_facet].functionSelectors.push(sel);
        }
    }

    function replaceFunctions(address _facet, bytes4[] memory _selectors) internal {
        require(_facet != address(0), "LibDiamond: facet=0");
        DiamondStorage storage ds = diamondStorage();

        uint256 selectorCount = ds.facetFunctionSelectors[_facet].functionSelectors.length;
        if (selectorCount == 0) {
            ds.facetFunctionSelectors[_facet].facetAddressPosition = ds.facetAddresses.length;
            ds.facetAddresses.push(_facet);
        }

        for (uint256 i = 0; i < _selectors.length; i++) {
            bytes4 sel = _selectors[i];
            address oldFacet = ds.selectorToFacetAndPosition[sel].facetAddress;
            require(oldFacet != address(0), "LibDiamond: selector missing");
            require(oldFacet != _facet, "LibDiamond: same facet");

            _removeFunction(oldFacet, sel);
            ds.selectorToFacetAndPosition[sel] = FacetAddressAndPosition({
                facetAddress: _facet,
                functionSelectorPosition: uint96(ds.facetFunctionSelectors[_facet].functionSelectors.length)
            });
            ds.facetFunctionSelectors[_facet].functionSelectors.push(sel);
        }
    }

    function removeFunctions(address /*_facet*/, bytes4[] memory _selectors) internal {
        DiamondStorage storage ds = diamondStorage();
        for (uint256 i = 0; i < _selectors.length; i++) {
            bytes4 sel = _selectors[i];
            address oldFacet = ds.selectorToFacetAndPosition[sel].facetAddress;
            require(oldFacet != address(0), "LibDiamond: selector missing");
            _removeFunction(oldFacet, sel);
            delete ds.selectorToFacetAndPosition[sel];
        }
    }

    function _removeFunction(address _facet, bytes4 _selector) private {
        DiamondStorage storage ds = diamondStorage();
        FacetFunctionSelectors storage ffs = ds.facetFunctionSelectors[_facet];

        // swap & pop selector in facet's selector array
        uint256 pos = ds.selectorToFacetAndPosition[_selector].functionSelectorPosition;
        uint256 lastPos = ffs.functionSelectors.length - 1;

        if (pos != lastPos) {
            bytes4 lastSelector = ffs.functionSelectors[lastPos];
            ffs.functionSelectors[pos] = lastSelector;
            ds.selectorToFacetAndPosition[lastSelector].functionSelectorPosition = uint96(pos);
        }
        ffs.functionSelectors.pop();

        // if facet has no more selectors, remove facet address
        if (ffs.functionSelectors.length == 0) {
            uint256 facetPos = ffs.facetAddressPosition;
            uint256 lastFacetPos = ds.facetAddresses.length - 1;

            if (facetPos != lastFacetPos) {
                address lastFacet = ds.facetAddresses[lastFacetPos];
                ds.facetAddresses[facetPos] = lastFacet;
                ds.facetFunctionSelectors[lastFacet].facetAddressPosition = facetPos;
            }
            ds.facetAddresses.pop();
            delete ds.facetFunctionSelectors[_facet].facetAddressPosition;
        }
    }

    function diamondCut(
        IDiamondCut.FacetCut[] memory _diamondCut,
        address _init,
        bytes memory _calldata
    ) internal {
        for (uint256 i = 0; i < _diamondCut.length; i++) {
            IDiamondCut.FacetCutAction action = _diamondCut[i].action;
            if (action == IDiamondCut.FacetCutAction.Add) {
                addFunctions(_diamondCut[i].facetAddress, _diamondCut[i].functionSelectors);
            } else if (action == IDiamondCut.FacetCutAction.Replace) {
                replaceFunctions(_diamondCut[i].facetAddress, _diamondCut[i].functionSelectors);
            } else if (action == IDiamondCut.FacetCutAction.Remove) {
                removeFunctions(_diamondCut[i].facetAddress, _diamondCut[i].functionSelectors);
            } else {
                revert("LibDiamond: bad action");
            }
        }

        emit IDiamondCut.DiamondCut(_diamondCut, _init, _calldata);

        if (_init != address(0)) {
            (bool ok, bytes memory ret) = _init.delegatecall(_calldata);
            if (!ok) {
                if (ret.length > 0) {
                    assembly { revert(add(ret, 32), mload(ret)) }
                }
                revert("LibDiamond: init failed");
            }
        }
    }

    // --- ERC165 ---
    function setSupportedInterface(bytes4 _interfaceId, bool _supported) internal {
        diamondStorage().supportedInterfaces[_interfaceId] = _supported;
    }

    function supportsInterface(bytes4 _interfaceId) internal view returns (bool) {
        return diamondStorage().supportedInterfaces[_interfaceId];
    }
}
