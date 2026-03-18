// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

// ════════════════════════════════════════════════════════════════════════════════
//  FLUXDEX — DeployAll.s.sol
//  Deploys every FluxDEX contract in a single forge script broadcast.
//
//  Deployment order:
//    1. UniswapV3Factory
//    2. NonfungiblePositionManager
//    3. SwapRouter
//    4. FluxFactory
//    5. Approve token0 + token1 to FluxFactory
//    6. FluxFactory.createVault() — creates pool + deploys FluxVault
//    7. vault.startWatching()
//    8. vault.startBackupWatcher()
//
//  Required .env variables:
//    PRIVATE_KEY  — deployer private key (with 0x prefix)
//    MY_WETH      — your deployed myWETH ERC-20 address
//    MY_BASE      — your deployed myBASE ERC-20 address
//
//  Dry-run (no gas spent):
//    forge script script/DeployAll.s.sol:DeployAll \
//      --rpc-url https://api.infra.testnet.somnia.network \
//      --gas-estimate-multiplier 200
//
//  Broadcast:
//    forge script script/DeployAll.s.sol:DeployAll \
//      --rpc-url https://api.infra.testnet.somnia.network \
//      --gas-estimate-multiplier 200 \
//      --broadcast \
//      --slow
// ════════════════════════════════════════════════════════════════════════════════

import {Script, console2} from "forge-std/Script.sol";
import {FluxFactory}      from "../src/FluxFactory.sol";
import {FluxVault}        from "../src/FluxVault.sol";

// ── Uniswap V3 Core ───────────────────────────────────────────────────────────
import {UniswapV3Factory} from
    "lib/v3-core/contracts/UniswapV3Factory.sol";

// ── Uniswap V3 Periphery ──────────────────────────────────────────────────────
import {NonfungiblePositionManager} from
    "lib/v3-periphery/contracts/NonfungiblePositionManager.sol";
import {SwapRouter} from
    "lib/v3-periphery/contracts/SwapRouter.sol";

// ── Minimal ERC-20 interface ──────────────────────────────────────────────────
interface IERC20Deploy {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

// ─────────────────────────────────────────────────────────────────────────────

contract DeployAll is Script {

    // ── Pool parameters ───────────────────────────────────────────────────────
    uint24  constant FEE        = 3000;
    int24   constant HALF_WIDTH = 600;
    // sqrtPriceX96 for 1:1 price = 2^96
    uint160 constant SQRT_PRICE = 79228162514264337593543950336;
    // 1 token of each for initial LP position
    uint256 constant DEPOSIT    = 1 ether;
    // STT to fund vault for Reactivity subscriptions
    uint256 constant STT        = 80 ether;
    // Gas limits for Reactivity handler invocations
    uint64  constant GAS_SWAP   = 3_000_000;
    uint64  constant GAS_BK     = 2_000_000;

    function run() external {
        // ── Load env ─────────────────────────────────────────────────────────
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);
        address myWETH      = vm.envAddress("MY_WETH");
        address myBASE      = vm.envAddress("MY_BASE");

        console2.log("============================================");
        console2.log("  FluxDEX Full Deployment — Somnia Testnet");
        console2.log("============================================");
        console2.log("Deployer :", deployer);
        console2.log("myBASE   :", myBASE);
        console2.log("myWETH   :", myWETH);
        console2.log("");

        // ── Pre-flight checks ─────────────────────────────────────────────────
        require(
            IERC20Deploy(myBASE).balanceOf(deployer) >= DEPOSIT,
            "DeployAll: insufficient myBASE"
        );
        require(
            IERC20Deploy(myWETH).balanceOf(deployer) >= DEPOSIT,
            "DeployAll: insufficient myWETH"
        );
        require(
            deployer.balance >= STT + 5 ether,
            "DeployAll: insufficient STT for funding + gas"
        );
        console2.log("Pre-flight: OK");
        console2.log("");

        // ═════════════════════════════════════════════════════════════════════
        vm.startBroadcast(deployerKey);
        // ═════════════════════════════════════════════════════════════════════

        // ── Step 1: UniswapV3Factory ──────────────────────────────────────────
        console2.log("[1/8] Deploying UniswapV3Factory...");
        UniswapV3Factory uniFactory = new UniswapV3Factory();
        console2.log("      Done:", address(uniFactory));

        // ── Step 2: NonfungiblePositionManager ───────────────────────────────
        // Args: factory, WETH9 (use myWETH), tokenDescriptor (address(0) = no SVG)
        console2.log("[2/8] Deploying NonfungiblePositionManager...");
        NonfungiblePositionManager npm = new NonfungiblePositionManager(
            address(uniFactory),
            myWETH,
            address(0)
        );
        console2.log("      Done:", address(npm));

        // ── Step 3: SwapRouter ────────────────────────────────────────────────
        console2.log("[3/8] Deploying SwapRouter...");
        SwapRouter swapRouter = new SwapRouter(
            address(uniFactory),
            myWETH
        );
        console2.log("      Done:", address(swapRouter));

        // ── Step 4: FluxFactory ───────────────────────────────────────────────
        console2.log("[4/8] Deploying FluxFactory...");
        FluxFactory fluxFactory = new FluxFactory(address(npm));
        console2.log("      Done:", address(fluxFactory));

        // ── Step 5: Approve tokens to FluxFactory ────────────────────────────
        console2.log("[5/8] Approving tokens...");
        IERC20Deploy(myBASE).approve(address(fluxFactory), type(uint256).max);
        IERC20Deploy(myWETH).approve(address(fluxFactory), type(uint256).max);
        console2.log("      Done.");

        // ── Step 6: Create pool + vault ───────────────────────────────────────
        console2.log("[6/8] Creating pool + vault...");
        (address vaultAddr, address poolAddr) = fluxFactory.createVault{
            value: STT
        }(
            myBASE,
            myWETH,
            FEE,
            SQRT_PRICE,
            DEPOSIT,
            DEPOSIT,
            HALF_WIDTH
        );
        console2.log("      Pool  :", poolAddr);
        console2.log("      Vault :", vaultAddr);

        FluxVault vault = FluxVault(payable(vaultAddr));
        require(vault.owner() == deployer, "DeployAll: wrong vault owner");

        // ── Step 7: Start primary Swap subscription ───────────────────────────
        console2.log("[7/8] Starting Swap subscription...");
        vault.startWatching(GAS_SWAP);
        console2.log("      Sub ID:", vault.subscriptionId());

        // ── Step 8: Start BlockTick backup subscription ───────────────────────
        console2.log("[8/8] Starting BlockTick backup subscription...");
        vault.startBackupWatcher(GAS_BK);
        console2.log("      Backup Sub ID:", vault.backupSubscriptionId());

        vm.stopBroadcast();
        // ═════════════════════════════════════════════════════════════════════

        // ── Print summary ─────────────────────────────────────────────────────
        console2.log("");
        console2.log("============================================");
        console2.log("  All contracts deployed successfully");
        console2.log("============================================");
        console2.log("UniswapV3Factory :", address(uniFactory));
        console2.log("NPM              :", address(npm));
        console2.log("SwapRouter       :", address(swapRouter));
        console2.log("FluxFactory      :", address(fluxFactory));
        console2.log("Pool             :", poolAddr);
        console2.log("Vault            :", vaultAddr);
        console2.log("Sub ID           :", vault.subscriptionId());
        console2.log("Backup Sub ID    :", vault.backupSubscriptionId());
        console2.log("Vault STT        :", address(vault).balance / 1 ether, "STT");
        console2.log("");
        console2.log("Explorer:");
        console2.log("  https://shannon-explorer.somnia.network/address/",
            vaultAddr);
        console2.log("============================================");

        // ── Write deployment.env ──────────────────────────────────────────────
        vm.writeFile(
            "deployment.env",
            string.concat(
                "FACTORY_ADDRESS=",      vm.toString(address(uniFactory)), "\n",
                "NPM_ADDRESS=",          vm.toString(address(npm)),         "\n",
                "SWAP_ROUTER_ADDRESS=",  vm.toString(address(swapRouter)),  "\n",
                "FLUX_FACTORY_ADDRESS=", vm.toString(address(fluxFactory)), "\n",
                "POOL_ADDRESS=",         vm.toString(poolAddr),             "\n",
                "VAULT_ADDRESS=",        vm.toString(vaultAddr),            "\n"
            )
        );
        console2.log("Addresses saved to deployment.env");
    }
}
