// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

// ════════════════════════════════════════════════════════════════════════════════
//  FLUXDEX — FluxVault.sol
//  JIT Liquidity Rebalancer on Somnia Testnet
//  Listens to Uniswap V3 Swap events via Somnia Reactivity and recenters the
//  LP position around the new tick in the following block.
//
//  Solidity 0.8.19 STRICT — do NOT upgrade to 0.8.20+ (PUSH0 / EIP-3855 breaks
//  Uniswap V3 periphery compilation on Somnia's EVM fork).
//
//  Somnia gas model awareness (cold SLOAD = ~1,000,100 gas vs Ethereum's 2,100):
//    • All storage reads in hot paths are cached to memory at the top of each fn.
//    • Mutable config is packed into a single storage slot (VaultConfig struct).
//    • Events are minimal — Somnia LOG = ~13x Ethereum.
//    • Total cold slots touched per _rebalance = 5 → ~5M gas floor.
//      Set subscription gasLimit ≥ 3_000_000; see NOTE below for a two-phase
//      workaround if the full rebalance exceeds the validator gas ceiling.
// ════════════════════════════════════════════════════════════════════════════════

// ──────────────────────────────────────────────────────────────────────────────
//  UNISWAP V3 INTERFACES
// ──────────────────────────────────────────────────────────────────────────────

/// @notice Minimal IUniswapV3Pool — only the methods FluxVault touches.
interface IUniswapV3Pool {
    /// @notice Returns the pool's current price + tick state.
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

    /// @notice Pool fee in hundredths of a bip (3000 = 0.3 %).
    function fee() external view returns (uint24);

    function tickSpacing() external view returns (int24);

    function observe(
        uint32[] calldata secondsAgos
    )
        external
        view
        returns (
            int56[] memory tickCumulatives,
            uint160[] memory secondsPerLiquidityCumulativeX128s
        );
}

/// @notice Minimal INonfungiblePositionManager — only the methods FluxVault needs.
interface INonfungiblePositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    /// @notice Mints a new LP position NFT.
    function mint(
        MintParams calldata params
    )
        external
        returns (
            uint256 tokenId,
            uint128 liquidity,
            uint256 amount0,
            uint256 amount1
        );

    /// @notice Returns the on-chain data for an LP position.
    function positions(
        uint256 tokenId
    )
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        );

    /// @notice Removes liquidity from the position (does NOT collect tokens).
    function decreaseLiquidity(
        DecreaseLiquidityParams calldata params
    ) external returns (uint256 amount0, uint256 amount1);

    /// @notice Transfers owed tokens to `recipient`.
    function collect(
        CollectParams calldata params
    ) external returns (uint256 amount0, uint256 amount1);

    /// @notice Burns a zero-liquidity NFT.
    function burn(uint256 tokenId) external;
}

/// @notice Minimal ERC-20 interface.
interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(
        address owner,
        address spender
    ) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool);
}

// ──────────────────────────────────────────────────────────────────────────────
//  SOMNIA REACTIVITY — MANUAL 0.8.19 INJECTION
//  DO NOT replace with `import { SomniaEventHandler }` — that package targets
//  Solidity ^0.8.30 and will break the entire Uniswap V3 compilation tree.
// ──────────────────────────────────────────────────────────────────────────────

/// @notice Subscription configuration passed to the Somnia Reactivity precompile.
/// @dev    Mirrors the canonical SubscriptionData struct from the Somnia protocol.
///         Manually injected here to remain compatible with Solidity 0.8.19.
struct SubscriptionData {
    /// @dev eventTopics[0] is the event signature hash; bytes32(0) = wildcard.
    bytes32[4] eventTopics;
    /// @dev tx.origin filter; address(0) = wildcard.
    address origin;
    /// @dev msg.sender filter; address(0) = wildcard.
    address caller;
    /// @dev Emitting contract filter; address(0) = wildcard.
    address emitter;
    /// @dev Contract whose `handlerFunctionSelector` will be invoked.
    address handlerContractAddress;
    /// @dev Usually `onEvent.selector` on the handler contract.
    bytes4 handlerFunctionSelector;
    /// @dev Validator tip in wei.  Minimum: 2 gwei = 2_000_000_000.
    uint64 priorityFeePerGas;
    /// @dev Fee ceiling in wei.  Minimum: 10 gwei = 10_000_000_000.
    uint64 maxFeePerGas;
    /// @dev Maximum gas units per handler invocation.
    uint64 gasLimit;
    /// @dev If true, validator retries delivery if the block is full.
    bool isGuaranteed;
    /// @dev If true, multiple events in one block are batched into one call.
    bool isCoalesced;
}

/// @notice Interface for the Somnia Reactivity Precompile at 0x0100.
interface ISomniaReactivityPrecompile {
    /// @notice Registers an on-chain subscription.
    /// @param  data  Fully-populated SubscriptionData struct.
    /// @return subscriptionId  Unique ID assigned by the precompile.
    function subscribe(
        SubscriptionData calldata data
    ) external returns (uint256 subscriptionId);

    /// @notice Cancels a subscription (caller must be the original subscriber).
    /// @param  subscriptionId  ID returned by `subscribe`.
    function unsubscribe(uint256 subscriptionId) external;

    /// @notice Returns the subscription config and its owner.
    function getSubscriptionInfo(
        uint256 subscriptionId
    ) external view returns (SubscriptionData memory, address owner);
}

// ──────────────────────────────────────────────────────────────────────────────
//  FLUXVAULT
// ──────────────────────────────────────────────────────────────────────────────

/// @title  FluxVault
/// @notice Core of FluxDEX — a Just-In-Time Liquidity Rebalancer for a Uniswap V3
/// @dev    Uses Somnia Reactivity to subscribe to the pool's `Swap` event. Whenever
///         a swap pushes the tick outside [tickLower, tickUpper], the validator
///         invokes `onEvent` in the subsequent block. The vault then:
///           1. Calls `decreaseLiquidity` to drain the old position.
///           2. Calls `collect` to retrieve tokens + accrued fees.
///           3. Burns the old LP NFT.
///           4. Mints a fresh position centered on the new tick.
///
///         ⚠ SOMNIA GAS NOTE
///         Cold SLOAD on Somnia = ~1,000,100 gas (vs 2,100 on Ethereum). This
///         contract caches ALL storage variables into memory at the top of every
///         hot function and packs mutable config into a single storage slot.
///         The full rebalance path touches ~5 cold slots + external Uniswap calls;
///         set `startWatching(gasLimit)` to at least 3_000_000.  If you hit the
///         validator gas ceiling, switch to the two-phase pattern: have `onEvent`
///         only write `pendingTick` (1 SSTORE), then call `executeRebalance()`
///         from a keeper bot.
///
///         ⚠ TIMING NOTE
///         Somnia Reactivity delivers handler invocations in the block AFTER the
///         triggering event, not in the same block. "JIT" here means next-block
///         reactive rebalancing (~100 ms on Somnia's 10 block/s chain).
///
///         ⚠ SUBSCRIPTION FUNDING
///         The vault contract itself must hold ≥ 32 STT before `startWatching` is
///         called. Send STT directly to the vault address; it accepts native tokens
///         via `receive()`.
contract FluxVault {
    // ═══════════════════════════════════════════════════════════════════════════
    //  CUSTOM ERRORS
    //  Cheaper than string reverts on Somnia (no KECCAK of revert string).
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev Reverts when caller is not the contract owner.
    error NotOwner();

    /// @dev Reverts when `onEvent` is called by anyone other than the precompile.
    error NotPrecompile();

    /// @dev Reverts when `initializeFirstPosition` is called more than once.
    error AlreadyInitialized();

    /// @dev Reverts when an operation requires an initialized position but none exists.
    error NotInitialized();

    /// @dev Reverts when `startWatching` is called while already subscribed.
    error AlreadyWatching();

    /// @dev Reverts when `stopWatching` is called while not subscribed.
    error NotWatching();

    /// @dev Reverts when a zero address is supplied where one is not permitted.
    error ZeroAddress();

    /// @dev Reverts when tick range parameters are invalid (e.g. halfWidth ≤ 0).
    error InvalidTickRange();

    /// @dev Reverts when startBackupWatcher is called while already active.
    error BackupAlreadyWatching();

    /// @dev Reverts when stopBackupWatcher is called while not active.
    error BackupNotWatching();

    /// @dev Reverts when the vault's STT balance is below the 32 STT minimum.
    /// @param required  Minimum balance needed (32 STT = 32e18 wei).
    /// @param actual    Vault's current STT balance.
    error InsufficientSTTBalance(uint256 required, uint256 actual);

    /// @dev Reverts when a native-token (STT) transfer fails.
    error STTTransferFailed();

    /// @dev Reverts when an ERC-20 transfer call returns false.
    error TokenTransferFailed();

    /// @dev Reverts when a reentrant call is detected.
    error Reentrancy();

    // ═══════════════════════════════════════════════════════════════════════════
    //  CONSTANTS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice How many blocks between each BlockTick backup check.
    /// @dev    50 blocks = ~5 seconds on Somnia (10 blocks/sec).
    ///         Reduces STT drain from BlockTick firing every single block.
    uint256 public constant BACKUP_CHECK_INTERVAL = 10;

    /// @notice Cooldown after a failed rebalance before BlockTick retries again.
    /// @dev    Prevents infinite failure loops from draining STT every block.
    uint256 public constant BACKUP_FAILURE_COOLDOWN = 100;

    /// @notice keccak256("BlockTick(uint64)") — Somnia system event topic.
    bytes32 public constant BLOCK_TICK_TOPIC = keccak256("BlockTick(uint64)");

    /// @notice Maximum allowed deviation between swap tick and TWAP tick.
    /// @dev    887272 = max Uniswap V3 tick, effectively disabling the TWAP
    ///         anti-manipulation check. Safe for demo; parameterize per-pool on mainnet.
    int24 public constant MAX_TICK_DEVIATION = 887272;

    /// @notice TWAP window in seconds.
    uint32 public constant TWAP_WINDOW = 300; // 5 minutes

    /// @notice Somnia Reactivity Precompile address (all networks).
    ISomniaReactivityPrecompile public constant PRECOMPILE =
        ISomniaReactivityPrecompile(0x0000000000000000000000000000000000000100);

    /// @notice keccak256 of the Uniswap V3 `Swap` event signature.
    /// @dev    Swap(address,address,int256,int256,uint160,uint128,int24)
    bytes32 public constant SWAP_TOPIC =
        0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67;

    /// @notice token0 of the managed pool (lower address of the pair).
    address public immutable token0;

    /// @notice token1 of the managed pool (higher address of the pair).
    address public immutable token1;

    /// @notice Minimum STT balance the vault must hold for a live Reactivity sub.
    uint256 public constant MIN_STT_BALANCE = 32 ether; // 32 STT (18 decimals)

    /// @notice Denominator used in the `SubscriptionData` gas fields.
    /// @dev    Stored as named constants to avoid magic numbers in `startWatching`.
    uint64 public constant PRIORITY_FEE_PER_GAS = 2_000_000_000; // 2 gwei
    uint64 public constant MAX_FEE_PER_GAS = 10_000_000_000; // 10 gwei

    // ═══════════════════════════════════════════════════════════════════════════
    //  STORAGE
    //
    //  Layout is deliberately tight to minimise the number of cold SLOADs on
    //  Somnia (each cold slot costs ~1,000,100 gas).
    //
    //  Slot 0  — owner            (address, 20 bytes)
    //  Slot 1  — pool             (address, 20 bytes)
    //  Slot 2  — npm              (address, 20 bytes)
    //  Slot 3  — tokenId          (uint256, 32 bytes)  — current LP NFT
    //  Slot 4  — subscriptionId   (uint256, 32 bytes)
    //  slot 5  - _locked          (uint256, 32 bytes)
    //  Slot 6  — config           (VaultConfig struct, 17 bytes packed into 1 slot)
    //
    //  Hot-path functions cache all slots into memory before any branching.
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Packed mutable configuration — fits in exactly one 32-byte slot.
    /// @dev    Changing any field costs one warm SSTORE (~200,100 gas on Somnia).
    struct VaultConfig {
        int24 tickLower; // 3 bytes — lower bound of current position
        int24 tickUpper; // 3 bytes — upper bound of current position
        int24 halfWidth; // 3 bytes — half the desired tick range width
        int24 tickSpacing; // 3 bytes — pool tick spacing (60 for 0.3 % fee)
        uint24 poolFee; // 3 bytes — pool fee tier (e.g. 3000)
        bool initialized; // 1 byte  — true after first position minted
        bool watching; // 1 byte  — true while a Reactivity sub is active
    }
    // total: 17 bytes → fits in a single 32-byte slot ✓

    // ── Slot 0 ──────────────────────────────────────────────────────────────
    /// @notice Address authorised to call admin functions.
    address public owner;

    // ── Slot 1 ──────────────────────────────────────────────────────────────
    /// @notice The Uniswap V3 pool being managed.
    address public pool;

    // ── Slot 2 ──────────────────────────────────────────────────────────────
    /// @notice Uniswap V3 NonfungiblePositionManager address.
    address public npm;

    // ── Slot 3 ──────────────────────────────────────────────────────────────
    /// @notice Token ID of the vault's current LP NFT (0 = no active position).
    uint256 public tokenId;

    // ── Slot 4 ──────────────────────────────────────────────────────────────
    /// @notice Reactivity subscription ID returned by `PRECOMPILE.subscribe` (0 = none).
    uint256 public subscriptionId;

    // ── Slot 5 ──────────────────────────────────────────────────────────────
    /// @notice Reactivity subscription ID for the BlockTick backup watcher (0 = none).
    uint256 public backupSubscriptionId;

    // ── Slot 6 ──────────────────────────────────────────────────────────────
    /// @notice Last block number at which the backup watcher ran its range check.
    uint256 public lastBackupCheckBlock;

    /// @notice Last block number at which a rebalance failure was recorded.
    uint256 public lastRebalanceFailureBlock;

    // ── Slot 7 ──────────────────────────────────────────────────────────────
    /// @notice Reentrancy lock. 1 = unlocked, 2 = locked.
    /// @dev    Initialized to 1 (not 0) so the first lock costs a warm SSTORE
    ///         (~100 gas) instead of a cold new slot write (~200,100 gas on Somnia).
    uint256 private _locked;

    // ── Slot 9 ─────────────────────────────────────────────────────────────────────
    /// @notice Address from which the vault pulls tokens during auto-rebalance.
    /// @dev    Must pre-approve token0 + token1 to this vault (one-time unlimited).
    ///         Auto-set to vault deployer by FluxFactory. Set to address(0) to disable.
    address public adminFundingAddress;
    uint256 public lastMintAmount0;
    uint256 public lastMintAmount1;

    // ── Slot 8 ──────────────────────────────────────────────────────────────
    /// @notice All packed mutable vault config in a single storage slot.
    VaultConfig public config;

    // ═══════════════════════════════════════════════════════════════════════════
    //  EVENTS  (kept minimal — Somnia LOG cost ≈ 13× Ethereum)
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Emitted after a successful rebalance.
    /// @param newTick      The tick that triggered the rebalance.
    /// @param oldTokenId   The burned NFT.
    /// @param newTokenId   The freshly minted NFT.
    event Rebalanced(
        int24 indexed newTick,
        uint256 oldTokenId,
        uint256 newTokenId
    );

    /// @notice Emitted when the rebalance mint fails (e.g. insufficient tokens).
    event RebalanceFailed(int24 newTick, uint256 oldTokenId, string reason);

    /// @notice Emitted once after `initializeFirstPosition` succeeds.
    /// @param tokenId      The minted NFT ID.
    /// @param tickLower    Lower tick of the initial range.
    /// @param tickUpper    Upper tick of the initial range.
    event PositionInitialized(
        uint256 indexed tokenId,
        int24 tickLower,
        int24 tickUpper
    );

    /// @notice Emitted when a Reactivity subscription is created.
    /// @param subscriptionId  ID returned by the precompile.
    event WatchingStarted(uint256 indexed subscriptionId);

    /// @notice Emitted when the Reactivity subscription is cancelled.
    /// @param subscriptionId  ID that was cancelled.
    event WatchingStopped(uint256 indexed subscriptionId);

    // ═══════════════════════════════════════════════════════════════════════════
    //  MODIFIERS
    // ═══════════════════════════════════════════════════════════════════════════

    modifier onlyOwner() {
        _onlyOwner();
        _;
    }
    function _onlyOwner() internal {
        if (msg.sender != owner) revert NotOwner();
    }

    modifier onlyPrecompile() {
        _onlyPrecompile();
        _;
    }
    function _onlyPrecompile() internal {
        if (msg.sender != address(PRECOMPILE)) revert NotPrecompile();
    }

    modifier nonReentrant() {
        _nonReentrantBefore();
        _;
        _nonReentrantAfter();
    }
    function _nonReentrantBefore() internal {
        if (_locked == 2) revert Reentrancy();
        _locked = 2;
    }
    function _nonReentrantAfter() internal {
        _locked = 1;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Deploys FluxVault and locks in the pool, NPM, and range parameters.
    /// @dev    Does NOT mint a position or start watching — call the two-step setup:
    ///         1. `initializeFirstPosition(…)`
    ///         2. Fund with ≥ 32 STT, then `startWatching(gasLimit)`
    /// @param _pool        Address of the Uniswap V3 pool.
    /// @param _npm         Address of the NonfungiblePositionManager.
    /// @param _halfWidth   Half of the desired tick range (e.g. 600 = ±600 ticks).
    ///                     Must be a positive multiple of `_tickSpacing`.
    /// @param _tickSpacing Tick spacing for the fee tier (60 for 0.3 %).
    constructor(
        address _pool,
        address _npm,
        int24 _halfWidth,
        int24 _tickSpacing,
        address _token0,
        address _token1
    ) {
        if (_pool == address(0) || _npm == address(0)) revert ZeroAddress();
        if (_token0 == address(0) || _token1 == address(0))
            revert ZeroAddress();
        token0 = _token0;
        token1 = _token1;
        if (_halfWidth <= 0 || _tickSpacing <= 0) revert InvalidTickRange();

        owner = msg.sender;
        pool = _pool;
        npm = _npm;
        adminFundingAddress = msg.sender;
        // Read pool fee once and cache in the packed config slot (avoids a cold
        // external call on every rebalance).
        uint24 _poolFee = IUniswapV3Pool(_pool).fee();

        _locked = 1;

        config = VaultConfig({
            tickLower: 0,
            tickUpper: 0,
            halfWidth: _halfWidth,
            tickSpacing: _tickSpacing,
            poolFee: _poolFee,
            initialized: false,
            watching: false
        });

        IERC20(_token0).approve(_npm, type(uint256).max);
        IERC20(_token1).approve(_npm, type(uint256).max);
    }

    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    /// @notice Accepts native STT transfers so the vault can fund its subscription.
    receive() external payable {}

    // ═══════════════════════════════════════════════════════════════════════════
    //  PHASE 1 — INITIALIZE FIRST POSITION
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Mints the vault's first LP position, centered on the pool's current tick.
    /// @dev    Must be called by the owner before `startWatching`.

    ///         Token approvals to the NPM are set to `type(uint256).max` here and are
    ///         never revoked — safe because the vault itself holds the tokens.
    /// @param amount0Desired  Desired token0 amount to deposit.
    /// @param amount1Desired  Desired token1 amount to deposit.
    /// @param amount0Min      Minimum token0 (slippage guard; 0 is fine for testnet).
    /// @param amount1Min      Minimum token1 (slippage guard; 0 is fine for testnet).
    function initializeFirstPosition(
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 amount0Min,
        uint256 amount1Min
    ) external onlyOwner nonReentrant {
        // ── Cache storage reads (Somnia: each cold SLOAD = ~1M gas) ──────────
        VaultConfig memory cfg = config; // 1 cold SLOAD for entire packed slot
        address _pool = pool; // 1 cold SLOAD
        address _npm = npm; // 1 cold SLOAD

        if (cfg.initialized) revert AlreadyInitialized();

        // ── Read current tick from pool ───────────────────────────────────────
        (, int24 currentTick, , , , , ) = IUniswapV3Pool(_pool).slot0();

        // ── Compute tick range centered on currentTick ────────────────────────
        int24 _tickLower = _roundDown(
            currentTick - cfg.halfWidth,
            cfg.tickSpacing
        );
        int24 _tickUpper = _roundUp(
            currentTick + cfg.halfWidth,
            cfg.tickSpacing
        );

        // ── Mint the initial position ─────────────────────────────────────────
        (
            uint256 _tokenId,
            ,
            uint256 amount0Used,
            uint256 amount1Used
        ) = INonfungiblePositionManager(_npm).mint(
            INonfungiblePositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: cfg.poolFee,
                tickLower: _tickLower,
                tickUpper: _tickUpper,
                amount0Desired: amount0Desired,
                amount1Desired: amount1Desired,
                amount0Min: amount0Min,
                amount1Min: amount1Min,
                recipient: address(this),
                deadline: block.timestamp + 30 minutes
            })
        );

        // ── Write back to storage — batched into two slots ────────────────────
        tokenId = _tokenId; // slot 3
        lastMintAmount0 = amount0Used;
        lastMintAmount1 = amount1Used;

        cfg.tickLower = _tickLower;
        cfg.tickUpper = _tickUpper;
        cfg.initialized = true;
        config = cfg; // single SSTORE for the entire packed slot (slot 5)

        emit PositionInitialized(_tokenId, _tickLower, _tickUpper);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  PHASE 2A — START WATCHING (Subscribe to Reactivity)
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Registers a Reactivity subscription so the vault reacts to swaps.
    /// @dev    Requires:
    ///           • `initializeFirstPosition` has been called.
    ///           • The vault holds ≥ 32 STT (send STT to this address first).
    ///         The precompile records `address(this)` as the subscription owner, so
    ///         it is the vault's STT balance that satisfies the 32 STT minimum.
    /// @param  gasLimit  Max gas per `onEvent` invocation. Recommended: 3_000_000.
    ///                   A full rebalance touches ~5 cold storage slots + Uniswap
    ///                   calls; increase if you observe dropped callbacks.
    function startWatching(uint64 gasLimit) external onlyOwner {
        // ── Cache storage ─────────────────────────────────────────────────────
        VaultConfig memory cfg = config; // slot 5

        if (!cfg.initialized) revert NotInitialized();
        if (cfg.watching) revert AlreadyWatching();

        uint256 balance = address(this).balance;
        if (balance < MIN_STT_BALANCE)
            revert InsufficientSTTBalance(MIN_STT_BALANCE, balance);

        // ── Build SubscriptionData ────────────────────────────────────────────
        bytes32[4] memory topics;
        topics[0] = SWAP_TOPIC; // filter: only Uniswap V3 Swap events
        // topics[1..3] remain bytes32(0) = wildcard (any sender / recipient)

        SubscriptionData memory subData = SubscriptionData({
            eventTopics: topics,
            origin: address(0), // wildcard
            caller: address(0), // wildcard
            emitter: pool, // only THIS pool  (slot 1 warm)
            handlerContractAddress: address(this),
            handlerFunctionSelector: this.onEvent.selector,
            priorityFeePerGas: PRIORITY_FEE_PER_GAS, // 2 gwei — validator minimum
            maxFeePerGas: MAX_FEE_PER_GAS, // 10 gwei
            gasLimit: gasLimit,
            isGuaranteed: true, // retry if block is full
            isCoalesced: false // one invocation per swap
        });

        // ── Register with precompile ──────────────────────────────────────────
        uint256 subId = PRECOMPILE.subscribe(subData);

        // ── Write back to storage — batched ──────────────────────────────────
        subscriptionId = subId; // slot 4
        cfg.watching = true;
        config = cfg; // slot 5

        emit WatchingStarted(subId);
    }

    /// @notice Registers a BlockTick Reactivity subscription as a backup rebalance trigger.
    /// @dev    Fires every block. Reads current tick from slot0() and rebalances if
    ///         the position is out of range. Supplements the Swap subscription — does
    ///         not replace it. Requires vault to hold >= 32 STT (shared with primary sub).
    /// @param  gasLimit  Max gas per invocation. Recommended: 2_000_000 (lighter than
    ///                   Swap handler since it often returns early on the range check).
    function startBackupWatcher(uint64 gasLimit) external onlyOwner {
        VaultConfig memory cfg = config;

        if (!cfg.initialized) revert NotInitialized();
        if (backupSubscriptionId != 0) revert BackupAlreadyWatching();

        uint256 balance = address(this).balance;
        if (balance < MIN_STT_BALANCE)
            revert InsufficientSTTBalance(MIN_STT_BALANCE, balance);

        bytes32[4] memory topics;
        topics[0] = BLOCK_TICK_TOPIC;

        SubscriptionData memory subData = SubscriptionData({
            eventTopics: topics,
            origin: address(0),
            caller: address(0),
            emitter: address(PRECOMPILE), // ← system event emitter
            handlerContractAddress: address(this),
            handlerFunctionSelector: this.onEvent.selector,
            priorityFeePerGas: PRIORITY_FEE_PER_GAS,
            maxFeePerGas: MAX_FEE_PER_GAS,
            gasLimit: gasLimit,
            isGuaranteed: true,
            isCoalesced: false
        });

        uint256 subId = PRECOMPILE.subscribe(subData);
        backupSubscriptionId = subId;

        emit WatchingStarted(subId);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  PHASE 2B — REACTIVITY CALLBACK
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Entry point invoked by the Somnia Reactivity validator when a Swap fires.
    /// @dev    Caller MUST be the Reactivity Precompile (enforced by `onlyPrecompile`).
    ///         This replaces `_onEvent` from `SomniaEventHandler` — the guard logic
    ///         is inlined here rather than inherited, keeping us on Solidity 0.8.19.
    ///
    ///         Execution happens in the block AFTER the triggering swap — not the same
    ///         block. This is a Somnia protocol constraint, not a bug.
    ///
    ///         Swap event non-indexed ABI layout (what `data` contains):
    ///           (int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)
    ///
    /// @param  emitter      The pool address (trusted via subscription filter, ignored).
    /// @param  eventTopics  Event topics array (trusted via subscription filter, ignored).
    /// @param  data         ABI-encoded non-indexed Swap event fields.
    function onEvent(
        address emitter,
        bytes32[] calldata eventTopics,
        bytes calldata data
    ) external onlyPrecompile nonReentrant {
        VaultConfig memory cfg = config;

        if (emitter == pool) {
            // ── Path A: Swap event from pool ──────────────────────────────────
            (, , , , int24 newTick) = abi.decode(
                data,
                (int256, int256, uint160, uint128, int24)
            );
            if (newTick >= cfg.tickLower && newTick < cfg.tickUpper) return;
            _rebalance(newTick, cfg);
        } else if (emitter == address(PRECOMPILE)) {
            uint256 lastFailure = lastRebalanceFailureBlock;
            if (
                lastFailure != 0 &&
                block.number < lastFailure + BACKUP_FAILURE_COOLDOWN
            ) return;

            uint256 lastCheck = lastBackupCheckBlock;
            if (block.number < lastCheck + BACKUP_CHECK_INTERVAL) return;
            lastBackupCheckBlock = block.number;
            // ── Path B: BlockTick system event — backup rebalance check ───────
            // BlockTick fires every block on Somnia (~100ms) — check on every invocation.
            // Backup checks are throttled to avoid infinite retry loops draining STT.

            (, int24 currentTick, , , , , ) = IUniswapV3Pool(pool).slot0();
            if (currentTick >= cfg.tickLower && currentTick < cfg.tickUpper)
                return;
            _rebalance(currentTick, cfg);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  INTERNAL — REBALANCE LOGIC
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Burns the current LP position and mints a new one centred on `newTick`.
    /// @dev    Receives the already-loaded `cfg` from `onEvent` to avoid a redundant
    ///         cold SLOAD.  All other storage slots are loaded once at the top.
    ///
    ///         Step order:
    ///           1. Load remaining storage into memory.
    ///           2. Fetch current position liquidity (cold external call).
    ///           3. `decreaseLiquidity` → drain position.
    ///           4. `collect`           → pull tokens + fees to vault.
    ///           5. `burn`              → destroy the empty NFT.
    ///           6. Compute new centred tick range.
    ///           7. `mint`              → create new position.
    ///           8. Write updated state back to storage (batched).
    ///
    /// @param  newTick  The tick reported by the triggering Swap event.
    /// @param  cfg      Packed config already read into memory by the caller.
    function _rebalance(int24 newTick, VaultConfig memory cfg) internal {
        // ── Load remaining hot slots into memory (one read each) ──────────────
        uint256 _tokenId = tokenId; // slot 3
        address _npm = npm; // slot 2

        address _pool = pool;
        (int24 twapTick, bool twapAvailable) = _getTWAPTick(_pool);
        if (twapAvailable) {
            int24 deviation = newTick > twapTick
                ? newTick - twapTick
                : twapTick - newTick;
            if (deviation > MAX_TICK_DEVIATION) return;
        }
        // ── 1–4. Remove old position (ONLY if one exists) ────────────────────
        // When mint() previously failed, tokenId is set to 0 as a sentinel.
        // If tokenId==0 we have no active position to burn — skip to admin pull.
        if (_tokenId > 0) {
            // ── 1. Read current position liquidity ────────────────────────────
            uint128 liquidity;
            try INonfungiblePositionManager(_npm).positions(_tokenId) returns (
                uint96,
                address,
                address,
                address,
                uint24,
                int24,
                int24,
                uint128 _liquidity,
                uint256,
                uint256,
                uint128,
                uint128
            ) {
                liquidity = _liquidity;
            } catch Error(string memory reason) {
                _recordRebalanceFailure(newTick, _tokenId, reason);
                return;
            } catch {
                _recordRebalanceFailure(newTick, _tokenId, "positions failed");
                return;
            }

            // ── 2. Remove all liquidity ───────────────────────────────────────
            if (liquidity > 0) {
                try
                    INonfungiblePositionManager(_npm).decreaseLiquidity(
                        INonfungiblePositionManager.DecreaseLiquidityParams({
                            tokenId: _tokenId,
                            liquidity: liquidity,
                            amount0Min: 0, // no slippage protection — testnet
                            amount1Min: 0,
                            deadline: block.timestamp + 15 minutes
                        })
                    )
                returns (uint256, uint256) {} catch Error(string memory reason) {
                    _recordRebalanceFailure(newTick, _tokenId, reason);
                    return;
                } catch {
                    _recordRebalanceFailure(
                        newTick,
                        _tokenId,
                        "decreaseLiquidity failed"
                    );
                    return;
                }
            }

            // ── 3. Collect all tokens + fees to vault ────────────────────────
            try
                INonfungiblePositionManager(_npm).collect(
                    INonfungiblePositionManager.CollectParams({
                        tokenId: _tokenId,
                        recipient: address(this),
                        amount0Max: type(uint128).max,
                        amount1Max: type(uint128).max
                    })
                )
            returns (uint256, uint256) {} catch Error(string memory reason) {
                _recordRebalanceFailure(newTick, _tokenId, reason);
                return;
            } catch {
                _recordRebalanceFailure(newTick, _tokenId, "collect failed");
                return;
            }

            // ── 4. Burn the empty NFT ─────────────────────────────────────────
            try INonfungiblePositionManager(_npm).burn(_tokenId) {
                // no-op
            } catch Error(string memory reason) {
                _recordRebalanceFailure(newTick, _tokenId, reason);
                return;
            } catch {
                _recordRebalanceFailure(newTick, _tokenId, "burn failed");
                return;
            }
        }
        // ── 5. Read vault token balances after collecting old position ───────────
        uint256 bal0 = IERC20(token0).balanceOf(address(this));
        uint256 bal1 = IERC20(token1).balanceOf(address(this));
        uint256 target0 = lastMintAmount0;
        uint256 target1 = lastMintAmount1;

        // ── 6. Admin pull-funding: top up whichever token is short ──────────────
        // The vault admin pre-approves both pool tokens once (unlimited allowance).
        // On every rebalance, the vault pulls only the deficit from the admin's
        // wallet — enough to make it proportional, capped by admin balance/allowance.
        address _admin = adminFundingAddress;
        if (_admin != address(0)) {
            // If the vault is completely empty, bootstrap it from the last
            // successful mint amounts so tokenId=0 can recover autonomously.
            if (bal0 == 0 && bal1 == 0) {
                if (target0 > 0) {
                    uint256 adminBal0 = IERC20(token0).balanceOf(_admin);
                    uint256 adminAllow0 = IERC20(token0).allowance(
                        _admin,
                        address(this)
                    );
                    uint256 canPull0 = adminBal0 < adminAllow0
                        ? adminBal0
                        : adminAllow0;
                    if (canPull0 > 0) {
                        uint256 pullAmt0 = canPull0 < target0
                            ? canPull0
                            : target0;
                        try
                            IERC20(token0).transferFrom(
                                _admin,
                                address(this),
                                pullAmt0
                            )
                        returns (bool) {} catch {}
                    }
                }

                if (target1 > 0) {
                    uint256 adminBal1 = IERC20(token1).balanceOf(_admin);
                    uint256 adminAllow1 = IERC20(token1).allowance(
                        _admin,
                        address(this)
                    );
                    uint256 canPull1 = adminBal1 < adminAllow1
                        ? adminBal1
                        : adminAllow1;
                    if (canPull1 > 0) {
                        uint256 pullAmt1 = canPull1 < target1
                            ? canPull1
                            : target1;
                        try
                            IERC20(token1).transferFrom(
                                _admin,
                                address(this),
                                pullAmt1
                            )
                        returns (bool) {} catch {}
                    }
                }

                bal0 = IERC20(token0).balanceOf(address(this));
                bal1 = IERC20(token1).balanceOf(address(this));
            }

            // If we have a historical two-sided mint, use that ratio as the target.
            // This keeps funding correct for pairs with different decimals / prices.
            if (target0 > 0 && target1 > 0) {
                if (bal0 > 0 && bal1 * target0 < bal0 * target1) {
                    uint256 desired1 = (bal0 * target1) / target0;
                    uint256 needed1 = desired1 > bal1 ? desired1 - bal1 : 0;
                    if (needed1 > 0) {
                        uint256 adminBal1 = IERC20(token1).balanceOf(_admin);
                        uint256 adminAllow1 = IERC20(token1).allowance(
                            _admin,
                            address(this)
                        );
                        uint256 canPull1 = adminBal1 < adminAllow1
                            ? adminBal1
                            : adminAllow1;
                        if (canPull1 > 0) {
                            uint256 pullAmt1 = canPull1 < needed1
                                ? canPull1
                                : needed1;
                            try
                                IERC20(token1).transferFrom(
                                    _admin,
                                    address(this),
                                    pullAmt1
                                )
                            returns (bool) {} catch {}
                            bal1 = IERC20(token1).balanceOf(address(this));
                        }
                    }
                }
                if (bal1 > 0 && bal0 * target1 < bal1 * target0) {
                    uint256 desired0 = (bal1 * target0) / target1;
                    uint256 needed0 = desired0 > bal0 ? desired0 - bal0 : 0;
                    if (needed0 > 0) {
                        uint256 adminBal0 = IERC20(token0).balanceOf(_admin);
                        uint256 adminAllow0 = IERC20(token0).allowance(
                            _admin,
                            address(this)
                        );
                        uint256 canPull0 = adminBal0 < adminAllow0
                            ? adminBal0
                            : adminAllow0;
                        if (canPull0 > 0) {
                            uint256 pullAmt0 = canPull0 < needed0
                                ? canPull0
                                : needed0;
                            try
                                IERC20(token0).transferFrom(
                                    _admin,
                                    address(this),
                                    pullAmt0
                                )
                            returns (bool) {} catch {}
                            bal0 = IERC20(token0).balanceOf(address(this));
                        }
                    }
                }
            } else {
                // Fallback for vaults that only have one-sided historical data.
                if (bal1 == 0 || (bal0 > 0 && bal1 * 20 < bal0)) {
                    uint256 needed1 = bal0 > bal1 ? bal0 - bal1 : 0;
                    if (needed1 > 0) {
                        uint256 adminBal1 = IERC20(token1).balanceOf(_admin);
                        uint256 adminAllow1 = IERC20(token1).allowance(
                            _admin,
                            address(this)
                        );
                        uint256 canPull1 = adminBal1 < adminAllow1
                            ? adminBal1
                            : adminAllow1;
                        if (canPull1 > 0) {
                            uint256 pullAmt1 = canPull1 < needed1
                                ? canPull1
                                : needed1;
                            try
                                IERC20(token1).transferFrom(
                                    _admin,
                                    address(this),
                                    pullAmt1
                                )
                            returns (bool) {} catch {}
                            bal1 = IERC20(token1).balanceOf(address(this));
                        }
                    }
                }
                if (bal0 == 0 || (bal1 > 0 && bal0 * 20 < bal1)) {
                    uint256 needed0 = bal1 > bal0 ? bal1 - bal0 : 0;
                    if (needed0 > 0) {
                        uint256 adminBal0 = IERC20(token0).balanceOf(_admin);
                        uint256 adminAllow0 = IERC20(token0).allowance(
                            _admin,
                            address(this)
                        );
                        uint256 canPull0 = adminBal0 < adminAllow0
                            ? adminBal0
                            : adminAllow0;
                        if (canPull0 > 0) {
                            uint256 pullAmt0 = canPull0 < needed0
                                ? canPull0
                                : needed0;
                            try
                                IERC20(token0).transferFrom(
                                    _admin,
                                    address(this),
                                    pullAmt0
                                )
                            returns (bool) {} catch {}
                            bal0 = IERC20(token0).balanceOf(address(this));
                        }
                    }
                }
            }
        }

        // ── Safety guard: if vault has zero of BOTH tokens, nothing to mint ────
        if (bal0 == 0 && bal1 == 0) {
            _recordRebalanceFailure(newTick, _tokenId, "zero balances");
            return;
        }

        // ── 7. Compute new tick range ─────────────────────────────────────────────
        // Center on newTick when admin funded both sides.
        // Fall back to one-sided anchor if vault still lacks one token after pull.
        bool onlyToken0;
        bool onlyToken1;
        if (target0 > 0 && target1 > 0) {
            onlyToken0 =
                (bal0 > 0) &&
                (bal1 == 0 || bal1 * target0 * 20 < bal0 * target1);
            onlyToken1 =
                (bal1 > 0) &&
                (bal0 == 0 || bal0 * target1 * 20 < bal1 * target0);
        } else {
            onlyToken0 = (bal0 > 0) && (bal1 == 0 || bal1 * 20 < bal0);
            onlyToken1 = (bal1 > 0) && (bal0 == 0 || bal0 * 20 < bal1);
        }
        int24 anchorTick = newTick;
        if (onlyToken0) {
            // Token0-only liquidity must be placed ABOVE the current price.
            anchorTick = newTick + cfg.halfWidth;
        } else if (onlyToken1) {
            // Token1-only liquidity must be placed BELOW the current price.
            anchorTick = newTick - cfg.halfWidth;
        }
        if (anchorTick < -887272 + cfg.halfWidth)
            anchorTick = -887272 + cfg.halfWidth;
        if (anchorTick > 887272 - cfg.halfWidth)
            anchorTick = 887272 - cfg.halfWidth;

        int24 newTickLower = _roundDown(
            anchorTick - cfg.halfWidth,
            cfg.tickSpacing
        );
        int24 newTickUpper = _roundUp(
            anchorTick + cfg.halfWidth,
            cfg.tickSpacing
        );

        if (newTickLower < -887272)
            newTickLower = _roundUp(-887272, cfg.tickSpacing);
        if (newTickUpper > 887272)
            newTickUpper = _roundDown(887272, cfg.tickSpacing);
        if (newTickLower >= newTickUpper)
            newTickLower = newTickUpper - cfg.tickSpacing;

        // ── 8. Mint new position — wrapped in try/catch so rebalance is fault-tolerant ─
        uint256 newTokenId;
        uint256 amount0Used;
        uint256 amount1Used;
        try
            INonfungiblePositionManager(_npm).mint(
                INonfungiblePositionManager.MintParams({
                    token0: token0,
                    token1: token1,
                    fee: cfg.poolFee,
                    tickLower: newTickLower,
                    tickUpper: newTickUpper,
                    amount0Desired: bal0,
                    amount1Desired: bal1,
                    amount0Min: 0, // testnet — no sandwich risk
                    amount1Min: 0,
                    recipient: address(this),
                    deadline: block.timestamp + 15 minutes
                })
            )
        returns (
            uint256 _newTokenId,
            uint128,
            uint256 _amount0Used,
            uint256 _amount1Used
        ) {
            newTokenId = _newTokenId;
            amount0Used = _amount0Used;
            amount1Used = _amount1Used;
        } catch Error(string memory reason) {
            tokenId = 0; // sentinel: no active position — skip burn on next invocation
            _recordRebalanceFailure(newTick, _tokenId, reason);
            return;
        } catch {
            tokenId = 0; // sentinel: no active position — skip burn on next invocation
            _recordRebalanceFailure(newTick, _tokenId, "mint failed");
            return;
        }
        // ── 9. Write back to storage — all in one pass ────────────────────────
        tokenId = newTokenId; // slot 3
        lastMintAmount0 = amount0Used;
        lastMintAmount1 = amount1Used;
        lastRebalanceFailureBlock = 0;

        cfg.tickLower = newTickLower;
        cfg.tickUpper = newTickUpper;
        config = cfg; // single SSTORE for entire packed slot (slot 5)

        emit Rebalanced(newTick, _tokenId, newTokenId);
    }

    function _recordRebalanceFailure(
        int24 newTick,
        uint256 oldTokenId,
        string memory reason
    ) internal {
        lastRebalanceFailureBlock = block.number;
        emit RebalanceFailed(newTick, oldTokenId, reason);
    }

    function _getTWAPTick(
        address _pool
    ) internal view returns (int24 twapTick, bool available) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = TWAP_WINDOW;
        secondsAgos[1] = 0;

        try IUniswapV3Pool(_pool).observe(secondsAgos) returns (
            int56[] memory tickCumulatives,
            uint160[] memory
        ) {
            int56 delta = tickCumulatives[1] - tickCumulatives[0];
            // forge-lint: disable-next-line(unsafe-typecast)
            // Safe: TWAP_WINDOW=300, max delta over 300s fits well within int24 range
            twapTick = int24(delta / int56(uint56(TWAP_WINDOW)));
            available = true;
        } catch {
            twapTick = 0;
            available = false;
        }
    }
    // ═══════════════════════════════════════════════════════════════════════════
    //  ADMIN FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Sets the address from which the vault pulls tokens during auto-rebalance.
    /// @dev    The address must pre-approve both pool tokens to this vault (one-time).
    ///         FluxFactory sets this to msg.sender automatically on vault creation.
    ///         Set to address(0) to disable admin pull-funding.
    function setAdminFundingAddress(address _admin) external onlyOwner {
        adminFundingAddress = _admin;
    }

    /// @notice Forces an immediate rebalance using the pool's current tick.
    /// @dev    Owner escape hatch for demos and recovery if Reactivity is delayed.
    ///         Unlike `onEvent`, this bypasses the out-of-range guard and recenters
    ///         the position around the latest on-chain pool tick right away.
    function manualRebalance() external onlyOwner nonReentrant {
        VaultConfig memory cfg = config;
        if (!cfg.initialized) revert NotInitialized();

        (, int24 currentTick, , , , , ) = IUniswapV3Pool(pool).slot0();
        _rebalance(currentTick, cfg);
    }

    /// @notice Cancels the active Reactivity subscription.
    /// @dev    Does NOT close the LP position. Use `initializeFirstPosition` flow to
    ///         restart after calling `startWatching` again.
    function stopWatching() external onlyOwner nonReentrant {
        VaultConfig memory cfg = config;
        if (!cfg.watching) revert NotWatching();

        uint256 subId = subscriptionId; // slot 4

        PRECOMPILE.unsubscribe(subId);

        subscriptionId = 0;
        cfg.watching = false;
        config = cfg;

        emit WatchingStopped(subId);
    }

    /// @notice Cancels the BlockTick backup subscription.
    function stopBackupWatcher() external onlyOwner nonReentrant {
        uint256 subId = backupSubscriptionId;
        if (subId == 0) revert BackupNotWatching();

        PRECOMPILE.unsubscribe(subId);

        backupSubscriptionId = 0;

        emit WatchingStopped(subId);
    }

    /// @notice Updates the half-width of the rebalance range for future positions.
    /// @dev    Takes effect on the next rebalance; does NOT move the current position.
    /// @param  _halfWidth  New half-width in ticks. Must be a positive multiple of tickSpacing.
    function setHalfWidth(int24 _halfWidth) external onlyOwner {
        if (_halfWidth <= 0) revert InvalidTickRange();
        VaultConfig memory cfg = config;
        cfg.halfWidth = _halfWidth;
        config = cfg;
    }

    /// @notice Transfers STT from the vault back to the owner.
    /// @param  amount  Amount of STT (in wei) to withdraw.
    function withdrawSTT(uint256 amount) external onlyOwner {
        (bool ok, ) = owner.call{value: amount}("");
        if (!ok) revert STTTransferFailed();
    }

    /// @notice Rescue ERC-20 tokens held by the vault.
    /// @param  token   ERC-20 token address.
    /// @param  amount  Amount to transfer to the owner.
    function rescueTokens(address token, uint256 amount) external onlyOwner {
        bool ok = IERC20(token).transfer(owner, amount);
        if (!ok) revert TokenTransferFailed();
    }

    /// @notice Transfers contract ownership to `newOwner`.
    /// @param  newOwner  Address of the new owner. Cannot be zero.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        owner = newOwner;
    }

    /// @notice Returns the vault's current STT (native token) balance.
    function sttBalance() external view returns (uint256) {
        return address(this).balance;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  INTERNAL — TICK MATH HELPERS
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Rounds `tick` DOWN to the nearest multiple of `spacing`.
    /// @dev    Handles negative ticks correctly (Solidity integer division truncates
    ///         toward zero, not toward negative infinity).
    /// @param  tick     Raw tick value (can be negative).
    /// @param  spacing  Tick spacing (must be > 0).
    /// @return          Largest multiple of `spacing` ≤ `tick`.
    function _roundDown(
        int24 tick,
        int24 spacing
    ) internal pure returns (int24) {
        int24 compressed = tick / spacing;
        // If tick is negative and not exactly divisible, truncation goes the wrong way.
        if (tick < 0 && tick % spacing != 0) compressed--;
        return compressed * spacing;
    }

    /// @notice Rounds `tick` UP to the nearest multiple of `spacing`.
    /// @param  tick     Raw tick value (can be negative).
    /// @param  spacing  Tick spacing (must be > 0).
    /// @return          Smallest multiple of `spacing` ≥ `tick`.
    function _roundUp(int24 tick, int24 spacing) internal pure returns (int24) {
        int24 rounded = _roundDown(tick, spacing);
        if (rounded < tick) rounded += spacing;
        return rounded;
    }
}
