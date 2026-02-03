// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

error NotFactory();
error DeployFailed();
error FactoryAlreadySet();
error ZeroAddress();

contract BeamioUserCardDeployerV07 {
    address public factory;

    function setFactoryOnce(address f) external {
        if (factory != address(0)) revert FactoryAlreadySet();
        if (f == address(0)) revert ZeroAddress();
        factory = f;
    }

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    /// @notice Deploy by raw init code (creationCode + abi.encode(constructorArgs))
    function deploy(bytes calldata initCode) external onlyFactory returns (address addr) {
        assembly {
            let ptr := mload(0x40)
            let len := initCode.length
            calldatacopy(ptr, initCode.offset, len)
            addr := create(0, ptr, len)
        }
        if (addr == address(0)) revert DeployFailed();
    }
}
