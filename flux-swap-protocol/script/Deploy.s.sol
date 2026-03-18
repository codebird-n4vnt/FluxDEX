// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

// ════════════════════════════════════════════════════════════════════════════════
//  FLUXDEX — Deploy.s.sol
//  Deployment script for FluxDEX on Somnia Testnet.
//
//  What this script does in one broadcast:
//    1.  Deploy FluxFactory
//    2.  Mint BASE tokens to deployer  (MockERC20 has public mint())
//    3.  Wrap STT → WETH              (WETH.deposit())
//    4.  Approve WETH + BASE to FluxFactory
//    5.  FluxFactory.createVault()    — sorts tokens, creates pool, deploys
//                                       vault, seeds tokens, inits LP position,
//                                       transfers ownership to deployer
//    6.  vault.startWatching()        — primary Swap subscription
//    7.  vault.startBackupWatcher()   — BlockTick backup subscription
//    8.  Log all addresses for .env
//
//  Required .env variables:
//    PRIVATE_KEY       — deployer key (must hold enough STT for gas + wrapping)
//    NPM_ADDRESS       — NonfungiblePositionManager
//    WETH_ADDRESS      — WETH token on Somnia testnet
//    BASE_ADDRESS      — MockERC20 BASE token on Somnia testnet
//
//  Run (dry run — no broadcast):
//    forge script script/Deploy.s.sol:DeployFluxDEX \
//      --rpc-url https://api.infra.testnet.somnia.network \
//      --gas-estimate-multiplier 200
//
//  Run (live):
//    forge script script/Deploy.s.sol:DeployFluxDEX \
//      --rpc-url https://api.infra.testnet.somnia.network \
//      --gas-estimate-multiplier 200 \
//      --broadcast \
//      --slow
// ════════════════════════════════════════════════════════════════════════════════

import {Script, console2} from "forge-std/Script.sol";
import {FluxFactory}      from "../src/FluxFactory.sol";
import {FluxVault}        from "../src/FluxVault.sol";

// ── Minimal interfaces ────────────────────────────────────────────────────────

interface IERC20Deploy {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IMockERC20 is IERC20Deploy {
    function mint(address to, uint256 amount) external;
}

interface IWETH is IERC20Deploy {
    function deposit() external payable;
}

// ─────────────────────────────────────────────────────────────────────────────

contract DeployFluxDEX is Script {

    // ── Pool parameters ───────────────────────────────────────────────────────
    uint24  constant POOL_FEE      = 3000;  // 0.3% fee tier, tick spacing = 60
    int24   constant HALF_WIDTH    = 600;   // ±600 ticks around current price

    // ── Token seed amounts ────────────────────────────────────────────────────
    // Both WETH and BASE have 18 decimals.
    uint256 constant WETH_SEED = 0.5 ether;   // 0.5 WETH wrapped from STT
    uint256 constant BASE_SEED = 500 ether;   // 500 BASE minted from MockERC20

    // ── STT funding for vault ─────────────────────────────────────────────────
    // Minimum required by Somnia Reactivity = 32 STT.
    // We send 80 STT — gives buffer for ongoing BlockTick invocations.
    uint256 constant STT_FOR_VAULT = 80 ether;

    // ── Initial pool price ────────────────────────────────────────────────────
    // sqrtPriceX96 for a 1:1 ratio between two 18-decimal tokens.
    // = sqrt(1) * 2^96 = 2^96
    // Adjust this if WETH and BASE should start at a different ratio.
    // To compute a custom ratio use FluxFactory.computeSqrtPriceX96().
    uint160 constant SQRT_PRICE_1_TO_1 = 79228162514264337593543950336;

    // ── Reactivity gas limits ──────────────────────────────────────────────────
    uint64 constant GAS_SWAP_HANDLER   = 3_000_000;
    uint64 constant GAS_BACKUP_HANDLER = 2_000_000;

    // ─────────────────────────────────────────────────────────────────────────

    function run() external {

        // ── Load from .env ────────────────────────────────────────────────────
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);
        address npm         = vm.envAddress("NPM_ADDRESS");
        address weth        = vm.envAddress("WETH_ADDRESS");
        address base        = vm.envAddress("BASE_ADDRESS");

        // ── Pre-flight ────────────────────────────────────────────────────────
        console2.log("=== FluxDEX Pre-flight ===");
        console2.log("Deployer:      ", deployer);
        console2.log("NPM:           ", npm);
        console2.log("WETH:          ", weth);
        console2.log("BASE:          ", base);
        console2.log("STT balance:   ", deployer.balance / 1e18, "STT");
        console2.log("");

        // Deployer needs: STT_FOR_VAULT + WETH_SEED (for wrapping) + gas buffer
        uint256 sttNeeded = STT_FOR_VAULT + WETH_SEED + 10 ether;
        require(
            deployer.balance >= sttNeeded,
            "Not enough STT. Need ~90.5 STT (80 for vault + 0.5 for WETH + 10 gas)"
        );

        // ═════════════════════════════════════════════════════════════════════
        //  BROADCAST
        // ═════════════════════════════════════════════════════════════════════
        vm.startBroadcast(deployerKey);

        // ── [1/7] Deploy FluxFactory ──────────────────────────────────────────
        console2.log("[1/7] Deploying FluxFactory...");
        FluxFactory factory = new FluxFactory(npm);
        console2.log("      Address:", address(factory));

        // ── [2/7] Mint BASE tokens to deployer ────────────────────────────────
        // MockERC20 exposes a public mint() — anyone can call it on testnet.
        console2.log("[2/7] Minting BASE tokens...");
        IMockERC20(base).mint(deployer, BASE_SEED);
        console2.log(
            "      BASE balance:",
            IMockERC20(base).balanceOf(deployer) / 1e18,
            "BASE"
        );

        // ── [3/7] Wrap STT → WETH ─────────────────────────────────────────────
        // WETH.deposit() converts native STT into ERC-20 WETH 1:1.
        console2.log("[3/7] Wrapping STT into WETH...");
        IWETH(weth).deposit{value: WETH_SEED}();
        console2.log(
            "      WETH balance:",
            IWETH(weth).balanceOf(deployer) / 1e18,
            "WETH"
        );

        // ── [4/7] Approve tokens to FluxFactory ───────────────────────────────
        // Factory pulls tokens from deployer via transferFrom inside createVault().
        console2.log("[4/7] Approving tokens to FluxFactory...");
        IERC20Deploy(weth).approve(address(factory), WETH_SEED);
        IERC20Deploy(base).approve(address(factory), BASE_SEED);
        console2.log("      Approved WETH + BASE");

        // ── [5/7] Create pool + vault ─────────────────────────────────────────
        // Factory internally:
        //   • Sorts WETH and BASE by address (WETH 0x936 < BASE 0x96E → token0=WETH)
        //   • Calls NPM.createAndInitializePoolIfNecessary → creates pool
        //   • Deploys FluxVault(pool, npm, halfWidth, tickSpacing, token0, token1)
        //   • Forwards msg.value (80 STT) to vault.receive()
        //   • Pulls WETH + BASE from deployer into vault via transferFrom
        //   • Calls vault.initializeFirstPosition()
        //   • Transfers vault ownership to deployer (msg.sender)
        //   • Registers pool → vault in factory registry
        //
        // msg.value = STT_FOR_VAULT is forwarded to the vault for subscriptions.
        console2.log("[5/7] Creating pool and vault...");
        console2.log("      Fee:      0.3% (3000)");
        console2.log("      Range:    +-600 ticks");
        console2.log("      STT sent: 80 STT");

        (address vaultAddress, address poolAddress) = factory.createVault{
            value: STT_FOR_VAULT
        }(
            weth,              // tokenA — factory sorts, order doesn't matter
            base,              // tokenB
            POOL_FEE,          // 3000
            SQRT_PRICE_1_TO_1, // 1:1 starting price
            WETH_SEED,         // amount0Desired — WETH is token0 after sorting
            BASE_SEED,         // amount1Desired — BASE is token1 after sorting
            HALF_WIDTH         // ±600 ticks
        );

        FluxVault vault = FluxVault(payable(vaultAddress));

        console2.log("      Pool:          ", poolAddress);
        console2.log("      Vault:         ", vaultAddress);
        console2.log("      LP Token ID:   ", vault.tokenId());
        console2.log("      Vault STT:     ", vault.sttBalance() / 1e18, "STT");
        console2.log("      Vault owner:   ", vault.owner());

        // Sanity check
        require(vault.owner() == deployer, "Vault owner is not deployer");

        // ── [6/7] Start primary Swap subscription ─────────────────────────────
        // Vault subscribes to pool's Swap events via Somnia Reactivity precompile.
        // When a swap pushes tick out of [tickLower, tickUpper], onEvent() fires
        // in the next block and _rebalance() recenters the LP position.
        console2.log("[6/7] Starting Swap subscription (primary)...");
        vault.startWatching(GAS_SWAP_HANDLER);
        console2.log("      Subscription ID:", vault.subscriptionId());

        // ── [7/7] Start BlockTick backup subscription ─────────────────────────
        // Fires every 50 blocks as a self-healing fallback.
        // Checks pool.slot0() directly and rebalances if tick is out of range.
        // Protects against missed Swap event deliveries.
        console2.log("[7/7] Starting BlockTick backup subscription...");
        vault.startBackupWatcher(GAS_BACKUP_HANDLER);
        console2.log("      Backup Sub ID: ", vault.backupSubscriptionId());

        vm.stopBroadcast();
        // ═════════════════════════════════════════════════════════════════════
        //  BROADCAST END
        // ═════════════════════════════════════════════════════════════════════

        _logSummary(deployer, address(factory), vaultAddress, poolAddress, weth, base);
    }

    // ── Summary ───────────────────────────────────────────────────────────────

    function _logSummary(
        address deployer,
        address factory,
        address vault,
        address pool,
        address weth,
        address base
    ) internal pure {
        console2.log("");
        console2.log("=====================================================");
        console2.log("FluxDEX Deployed");
        console2.log("=====================================================");
        console2.log("  Deployer     :", deployer);
        console2.log("  FluxFactory  :", factory);
        console2.log("  FluxVault    :", vault);
        console2.log("  Pool (WETH/BASE):", pool);
        console2.log("  WETH token   :", weth);
        console2.log("  BASE token   :", base);
        console2.log("  FLUX_FACTORY_ADDRESS=", factory);
        console2.log("  FLUX_VAULT_ADDRESS=  ", vault);
        console2.log("  POOL_ADDRESS=        ", pool);

        console2.log("  Explorer:");
        console2.log("  https://shannon-explorer.somnia.network/address/", vault);
        console2.log("=====================================================");
    }
}
