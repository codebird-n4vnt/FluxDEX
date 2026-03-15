// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {UniswapV3Factory} from "@uniswap/v3-core/contracts/UniswapV3Factory.sol";
import {NonfungiblePositionManager} from "@uniswap/v3-periphery/contracts/NonfungiblePositionManager.sol";

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20 is ERC20{
    constructor(string memory _name, string memory _symbol, uint256 _initialSupply) ERC20(_name, _symbol){
        _mint(msg.sender, _initialSupply);
    }
}

contract DeployUniswap is Script{
    function run() external{
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        vm.startBroadcast(deployerPrivateKey);
        MockERC20 mockWeth = new MockERC20("Wrapped eth", "WETH", 10000*10**18);
        MockERC20 mockBTC = new MockERC20("Bitcoin Somnia", "BTCS", 10000*10**18);
        UniswapV3Factory factory = new UniswapV3Factory();
        NonfungiblePositionManager positionManager = new NonfungiblePositionManager(address(factory), address(mockWeth), deployer);


        console.log("     ");
        console.log("Mock WETH deployed at ", address(mockWeth));
        console.log("Mock BTC deployed at ", address(mockBTC));
        console.log("Uniswap factory deployed at ", address(factory));
        console.log("Uniswap positionManager deployed at ", address(positionManager));
        
        vm.stopBroadcast();
    }
}