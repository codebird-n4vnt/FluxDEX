// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

// ════════════════════════════════════════════════════════════════════════════════
//  FLUXDEX — Deploy.s.sol
//  Foundry deployment script for FluxVault on Somnia Testnet.
//
//  Execution order (single broadcast):
//    1.  Deploy FluxVault
//    2.  Fund vault with STT (≥ 32 STT for Reactivity subscription)
//    3.  Transfer USDC + WETH from deployer to vault
//    4.  Approve NPM inside vault (handled inside initializeFirstPosition)
//    5.  initializeFirstPosition  → mints the first LP NFT
//    6.  startWatching            → registers the Reactivity subscription
//    7.  Log all key addresses + IDs to console
//
//  Solidity 0.8.19 STRICT — never upgrade to 0.8.20+ (PUSH0 breaks Uniswap V3).
//
//  Run (dry-run):
//    forge script script/Deploy.s.sol:DeployFluxDEX \
//      --rpc-url https://api.infra.testnet.somnia.network \
//      --gas-estimate-multiplier 200
//
//  Run (broadcast):
//    forge script script/Deploy.s.sol:DeployFluxDEX \
//      --rpc-url https://api.infra.testnet.somnia.network \
//      --gas-estimate-multiplier 200 \
//      --broadcast \
//      --slow                   ← sends txs one at a time; safer on Somnia testnet
//
//  Required environment variables (set in .env, never commit):
//    PRIVATE_KEY          — deployer EOA private key (must hold STT, USDC, WETH)
//    POOL_ADDRESS         — deployed Uniswap V3 USDC/WETH pool address
//    NPM_ADDRESS          — deployed NonfungiblePositionManager address
//
//  Optional overrides (all have sensible defaults):
//    HALF_WIDTH           — half-width of LP range in ticks (default: 600)
//    TICK_SPACING         — pool tick spacing (default: 60 for 0.3% fee)
//    AMOUNT0_DESIRED      — USDC to deposit for first position (default: 1000e6)
//    AMOUNT1_DESIRED      — WETH to deposit for first position (default: 0.5e18)
//    STT_FUNDING          — STT to send to vault in wei (default: 40e18 = 40 STT)
//    GAS_LIMIT_HANDLER    — Reactivity handler gasLimit (default: 3_000_000)
// ════════════════════════════════════════════════════════════════════════════════

import {Script, console2} from "forge-std/Script.sol";
import {FluxVault}        from "../src/FluxVault.sol";

// ── Minimal ERC-20 transfer interface used by the script ─────────────────────
interface IERC20Transfer {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

// ─────────────────────────────────────────────────────────────────────────────

/// @title  DeployFluxDEX
/// @notice One-shot Foundry script that deploys and fully initialises FluxVault
///         on the Somnia Testnet.
/// @dev    All transactions are sent inside a single `vm.startBroadcast` session.
///         The deployer wallet must hold sufficient:
///           • STT  — for gas + the ≥ 32 STT Reactivity subscription minimum
///           • USDC — for the initial LP position (USDC is token0)
///           • WETH — for the initial LP position (WETH is token1)
contract DeployFluxDEX is Script {

    // ═══════════════════════════════════════════════════════════════════════
    //  LOCKED CONSTANTS — Somnia Testnet
    // ═══════════════════════════════════════════════════════════════════════

    /// @dev USDC on Somnia Testnet (token0 — lower address).
    address constant USDC = 0x28bec7e30e6faee657a03e19bf1128aad7632a00;

    /// @dev WETH on Somnia Testnet (token1 — higher address).
    address constant WETH = 0x936Ab8C674bcb567CD5dEB85D8A216494704E9D8;

    // ═══════════════════════════════════════════════════════════════════════
    //  DEFAULTS  — override via env vars
    // ═══════════════════════════════════════════════════════════════════════

    /// @dev ±600 ticks around current price (~6 % range for 0.3 % fee pool).
    int24   constant DEFAULT_HALF_WIDTH        = 600;
    int24   constant DEFAULT_TICK_SPACING      = 60;

    /// @dev 1 000 USDC (6 decimals) + 0.5 WETH (18 decimals).
    uint256 constant DEFAULT_AMOUNT0_DESIRED   = 1_000e6;
    uint256 constant DEFAULT_AMOUNT1_DESIRED   = 0.5 ether;

    /// @dev 40 STT — comfortably above the 32 STT minimum, leaves buffer for fees.
    uint256 constant DEFAULT_STT_FUNDING       = 40 ether;

    /// @dev 3 M gas covers ~5 cold SLOADs + 4 Uniswap external calls.
    uint64  constant DEFAULT_GAS_LIMIT_HANDLER = 3_000_000;

    // ═══════════════════════════════════════════════════════════════════════
    //  RUN
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Main entry point called by `forge script`.
    function run() external {

        // ── 1. Load private key ───────────────────────────────────────────
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);

        // ── 2. Load required addresses from env ───────────────────────────
        address poolAddress = vm.envAddress("POOL_ADDRESS");
        address npmAddress  = vm.envAddress("NPM_ADDRESS");

        // ── 3. Load optional overrides (fall back to defaults) ────────────
        int24 halfWidth = _envInt24("HALF_WIDTH",      DEFAULT_HALF_WIDTH);
        int24 tickSpacing = _envInt24("TICK_SPACING",  DEFAULT_TICK_SPACING);

        uint256 amount0Desired  = _envUint256("AMOUNT0_DESIRED",   DEFAULT_AMOUNT0_DESIRED);
        uint256 amount1Desired  = _envUint256("AMOUNT1_DESIRED",   DEFAULT_AMOUNT1_DESIRED);
        uint256 sttFunding      = _envUint256("STT_FUNDING",       DEFAULT_STT_FUNDING);
        uint64  gasLimitHandler = uint64(_envUint256("GAS_LIMIT_HANDLER", DEFAULT_GAS_LIMIT_HANDLER));

        // ── 4. Pre-flight checks ──────────────────────────────────────────
        _preflightChecks(
            deployer,
            poolAddress,
            npmAddress,
            amount0Desired,
            amount1Desired,
            sttFunding
        );

        // ═════════════════════════════════════════════════════════════════
        //  BROADCAST START
        // ═════════════════════════════════════════════════════════════════
        vm.startBroadcast(deployerKey);

        // ── Step 1: Deploy FluxVault ──────────────────────────────────────
        console2.log("\n[1/5] Deploying FluxVault...");

        FluxVault vault = new FluxVault(
            poolAddress,
            npmAddress,
            halfWidth,
            tickSpacing
        );

        console2.log("      FluxVault deployed at:", address(vault));

        // ── Step 2: Fund vault with STT for Reactivity subscription ───────
        // The vault's receive() accepts native token transfers.
        // Reactivity requires the SUBSCRIPTION OWNER (= vault) to hold ≥ 32 STT.
        console2.log("\n[2/5] Funding vault with STT...");
        console2.log("      Sending:", sttFunding, "wei (", sttFunding / 1e18, " STT )");

        (bool ok,) = address(vault).call{value: sttFunding}("");
        require(ok, "Deploy: STT transfer to vault failed");

        console2.log("      Vault STT balance:", address(vault).balance / 1e18, "STT");

        // ── Step 3: Transfer tokens to vault for initial LP position ──────
        console2.log("\n[3/5] Transferring tokens to vault...");
        console2.log("      USDC:", amount0Desired / 1e6, "(6 dec)");
        console2.log("      WETH:", amount1Desired, "wei");

        bool ok0 = IERC20Transfer(USDC).transfer(address(vault), amount0Desired);
        require(ok0, "Deploy: USDC transfer to vault failed");

        bool ok1 = IERC20Transfer(WETH).transfer(address(vault), amount1Desired);
        require(ok1, "Deploy: WETH transfer to vault failed");

        // ── Step 4: Initialise the first LP position ──────────────────────
        // This call:
        //   • Approves the NPM for max USDC + WETH (done once, inside the vault)
        //   • Reads pool.slot0() for current tick
        //   • Mints the LP NFT centred on that tick ± halfWidth
        //   • Sets config.initialized = true
        console2.log("\n[4/5] Initializing first LP position...");

        vault.initializeFirstPosition(
            amount0Desired,
            amount1Desired,
            0,  // amount0Min — no slippage guard on testnet
            0   // amount1Min
        );

        console2.log("      LP NFT token ID:", vault.tokenId());
        (
            int24 tl,
            int24 tu,
            int24 hw,
            int24 ts,
            uint24 fee,
            bool  init,
            bool  watching
        ) = _unpackConfig(vault);
        console2.log("      tickLower:", tl);
        console2.log("      tickUpper:", tu);
        console2.log("      poolFee:  ", fee);
        console2.log("      initialized:", init);

        // Suppress unused var warnings (halfWidth, tickSpacing, watching
        // are correct but we only log the ones needed for verification)
        hw; ts; watching;

        // ── Step 5: Register Reactivity subscription ──────────────────────
        // startWatching calls PRECOMPILE.subscribe(SubscriptionData) which:
        //   • Filters on pool address + SWAP_TOPIC
        //   • Sets handlerFunctionSelector = onEvent.selector
        //   • Uses priorityFeePerGas=2gwei, maxFeePerGas=10gwei
        //   • Sets isGuaranteed=true, isCoalesced=false
        console2.log("\n[5/5] Starting Reactivity subscription...");
        console2.log("      gasLimit:", gasLimitHandler);

        vault.startWatching(gasLimitHandler);

        console2.log("      Subscription ID:", vault.subscriptionId());
        console2.log("      Vault is watching:", true);

        vm.stopBroadcast();
        // ═════════════════════════════════════════════════════════════════
        //  BROADCAST END
        // ═════════════════════════════════════════════════════════════════

        // ── Summary ───────────────────────────────────────────────────────
        _logSummary(vault, poolAddress, npmAddress, deployer);
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════════

    /// @dev Validates all pre-conditions before spending any gas on broadcast.
    ///      Reverts with a descriptive message if any check fails.
    function _preflightChecks(
        address deployer,
        address poolAddress,
        address npmAddress,
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 sttFunding
    ) internal view {
        console2.log("=== FluxDEX Pre-flight Checks ===");
        console2.log("Deployer:          ", deployer);
        console2.log("Pool:              ", poolAddress);
        console2.log("NPM:               ", npmAddress);

        // Addresses non-zero
        require(poolAddress != address(0), "Preflight: POOL_ADDRESS is zero");
        require(npmAddress  != address(0), "Preflight: NPM_ADDRESS is zero");

        // Deployer STT balance (needs gas + sttFunding)
        uint256 deployerSTT = deployer.balance;
        console2.log("Deployer STT bal:  ", deployerSTT / 1e18, "STT");
        require(
            deployerSTT >= sttFunding + 5 ether, // 5 STT buffer for gas
            "Preflight: deployer does not have enough STT (needs sttFunding + 5 STT gas buffer)"
        );

        // Deployer USDC balance
        uint256 deployerUSDC = IERC20Transfer(USDC).balanceOf(deployer);
        console2.log("Deployer USDC bal: ", deployerUSDC / 1e6, "USDC");
        require(
            deployerUSDC >= amount0Desired,
            "Preflight: deployer does not have enough USDC"
        );

        // Deployer WETH balance
        uint256 deployerWETH = IERC20Transfer(WETH).balanceOf(deployer);
        console2.log("Deployer WETH bal: ", deployerWETH, "wei WETH");
        require(
            deployerWETH >= amount1Desired,
            "Preflight: deployer does not have enough WETH"
        );

        console2.log("=== All pre-flight checks passed ===\n");
    }

    /// @dev Prints a structured deployment summary to console.
    function _logSummary(
        FluxVault vault,
        address   poolAddress,
        address   npmAddress,
        address   deployer
    ) internal view {
        console2.log("\n");
        console2.log("╔══════════════════════════════════════════╗");
        console2.log("║         FluxDEX Deployment Summary       ║");
        console2.log("╠══════════════════════════════════════════╣");
        console2.log("║ Network   : Somnia Testnet (50312)       ║");
        console2.log("╠══════════════════════════════════════════╣");
        console2.log("Deployer       :", deployer);
        console2.log("FluxVault      :", address(vault));
        console2.log("Pool           :", poolAddress);
        console2.log("NPM            :", npmAddress);
        console2.log("USDC (token0)  :", USDC);
        console2.log("WETH (token1)  :", WETH);
        console2.log("--------------------------------------------");
        console2.log("LP Token ID    :", vault.tokenId());
        console2.log("Subscription ID:", vault.subscriptionId());
        console2.log("Vault STT      :", address(vault).balance / 1e18, "STT");
        console2.log("╚══════════════════════════════════════════╝");
        console2.log("\nExplorer: https://shannon-explorer.somnia.network/address/", address(vault));
    }

    /// @dev Unpacks the VaultConfig struct from the vault's public getter.
    ///      The Solidity compiler generates a tuple getter for public structs.
    function _unpackConfig(FluxVault vault)
        internal
        view
        returns (
            int24  tickLower,
            int24  tickUpper,
            int24  halfWidth,
            int24  tickSpacing,
            uint24 poolFee,
            bool   initialized,
            bool   watching
        )
    {
        (tickLower, tickUpper, halfWidth, tickSpacing, poolFee, initialized, watching)
            = vault.config();
    }

    // ── Safe env helpers ──────────────────────────────────────────────────

    /// @dev Reads a uint256 env var, returning `defaultVal` if unset.
    function _envUint256(string memory key, uint256 defaultVal)
        internal
        view
        returns (uint256)
    {
        try vm.envUint(key) returns (uint256 v) { return v; }
        catch                                    { return defaultVal; }
    }

    /// @dev Reads an int24 env var (stored as int256), returning `defaultVal` if unset.
    function _envInt24(string memory key, int24 defaultVal)
        internal
        view
        returns (int24)
    {
        try vm.envInt(key) returns (int256 v) { return int24(v); }
        catch                                  { return defaultVal; }
    }
}
