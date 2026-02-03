// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Shared currency enum across UserCard / Oracle / Factory
///         Future currency additions should happen ONLY here.
library BeamioCurrency {
    enum CurrencyType { CAD, USD, JPY, CNY, USDC, HKD, EUR, SGD, TWD }

    uint8 internal constant CAD  = uint8(CurrencyType.CAD);
    uint8 internal constant USD  = uint8(CurrencyType.USD);
    uint8 internal constant JPY  = uint8(CurrencyType.JPY);
    uint8 internal constant CNY  = uint8(CurrencyType.CNY);
    uint8 internal constant USDC = uint8(CurrencyType.USDC);
    uint8 internal constant HKD  = uint8(CurrencyType.HKD);
    uint8 internal constant EUR  = uint8(CurrencyType.EUR);
    uint8 internal constant SGD  = uint8(CurrencyType.SGD);
    uint8 internal constant TWD  = uint8(CurrencyType.TWD);
}
