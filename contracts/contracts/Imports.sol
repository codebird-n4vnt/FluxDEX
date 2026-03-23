// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

// This file is only used so Hardhat compiles the repo-local FluxDEX contracts.
// We deploy Uniswap V3 contracts from prebuilt npm artifacts (so we don't rely on missing .sol sources).
import "./FluxFactory.sol";
import "./FluxVault.sol";