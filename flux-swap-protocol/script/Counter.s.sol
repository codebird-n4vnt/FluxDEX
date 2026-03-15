// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import {Script} from "forge-std/Script.sol";
import {FluxDEX} from "../src/FluxDEX.sol";

contract FluxDEXScript is Script {
    FluxDEX public f;

    function setUp() public {}

    function run() public {
        vm.startBroadcast();

        f = new FluxDEX();

        vm.stopBroadcast();
    }
}
