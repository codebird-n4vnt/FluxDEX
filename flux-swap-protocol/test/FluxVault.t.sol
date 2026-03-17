// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

// ════════════════════════════════════════════════════════════════════════════════
//  FLUXDEX — FluxVault.t.sol
//  Comprehensive Foundry test suite for FluxVault.
//
//  Test strategy:
//    • No live fork needed — all external dependencies (pool, NPM, precompile,
//      tokens) are replaced with lean mock contracts deployed in setUp().
//    • The Reactivity Precompile lives at a fixed address (0x0100). We use
//      vm.etch() to place MockPrecompile bytecode there so the vault's
//      `onlyPrecompile` modifier and PRECOMPILE.subscribe() both resolve
//      correctly without a live chain.
//    • USDC and WETH are constants in the current vault version. We use
//      vm.etch() to place MockERC20 bytecode at both addresses.
//
//  NOTE: This file targets the pre-factory FluxVault where token0/token1 are
//  hardcoded constants (USDC/WETH). After applying the factory refactor
//  (immutable token0/token1), update setUp() to pass token addresses as
//  constructor arguments and remove the vm.etch() calls for tokens.
//
//  Run all tests:
//    forge test --match-path test/FluxVault.t.sol -vvv
//
//  Run a single test:
//    forge test --match-test test_OnEvent_Swap_TickAboveUpper_Rebalances -vvv
//
//  Run fuzz tests only:
//    forge test --match-test testFuzz -vvv
// ════════════════════════════════════════════════════════════════════════════════

import {Test, console2} from "forge-std/Test.sol";
import {FluxVault}      from "../src/FluxVault.sol";

// ──────────────────────────────────────────────────────────────────────────────
//  MOCK — ERC-20
//  Minimal token. Mints freely, tracks balances and allowances.
//  Etched at USDC_ADDR and WETH_ADDR via vm.etch().
// ──────────────────────────────────────────────────────────────────────────────
contract MockERC20 {
    mapping(address => uint256)                     public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to]         += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from]             -= amount;
        balanceOf[to]               += amount;
        return true;
    }
}

// ──────────────────────────────────────────────────────────────────────────────
//  MOCK — UNISWAP V3 POOL
//  Configurable tick, TWAP, and observe() revert flag.
// ──────────────────────────────────────────────────────────────────────────────
contract MockPool {
    int24  public currentTick;
    bool   public twapShouldRevert;
    int56  public twapCumulative0;
    int56  public twapCumulative1;

    function setCurrentTick(int24 t)          external { currentTick      = t; }
    function setTwapShouldRevert(bool v)       external { twapShouldRevert = v; }

    /// @dev Sets cumulatives so computed TWAP = twapTick over 300s window.
    function setTwapTick(int24 twapTick) external {
        twapCumulative0 = 0;
        twapCumulative1 = int56(twapTick) * 300;
    }

    function slot0() external view returns (
        uint160, int24, uint16, uint16, uint16, uint8, bool
    ) {
        return (0, currentTick, 0, 0, 0, 0, true);
    }

    function fee() external pure returns (uint24) { return 3000; }

    function tickSpacing() external pure returns (int24) { return 60; }

    function observe(uint32[] calldata) external view returns (
        int56[] memory tickCumulatives,
        uint160[] memory secondsPerLiquidityCumulativeX128s
    ) {
        require(!twapShouldRevert, "MockPool: observe forced revert");
        tickCumulatives    = new int56[](2);
        tickCumulatives[0] = twapCumulative0;
        tickCumulatives[1] = twapCumulative1;
        secondsPerLiquidityCumulativeX128s = new uint160[](2);
    }
}

// ──────────────────────────────────────────────────────────────────────────────
//  MOCK — NONFUNGIBLE POSITION MANAGER
//  Tracks call counts and last arguments. Fires onERC721Received on mint.
// ──────────────────────────────────────────────────────────────────────────────
contract MockNPM {
    uint256 public mintCallCount;
    uint256 public burnCallCount;
    uint256 public decreaseLiquidityCallCount;
    uint256 public collectCallCount;

    int24   public lastMintTickLower;
    int24   public lastMintTickUpper;
    uint256 public lastBurnTokenId;

    uint256 public nextTokenId       = 1;
    uint128 public positionLiquidity = 1_000_000;

    struct MintParams {
        address token0; address token1; uint24 fee;
        int24 tickLower; int24 tickUpper;
        uint256 amount0Desired; uint256 amount1Desired;
        uint256 amount0Min;     uint256 amount1Min;
        address recipient;      uint256 deadline;
    }

    struct DecreaseLiquidityParams {
        uint256 tokenId; uint128 liquidity;
        uint256 amount0Min; uint256 amount1Min; uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId; address recipient;
        uint128 amount0Max; uint128 amount1Max;
    }

    function mint(MintParams calldata p)
        external
        returns (uint256 tokenId, uint128 liquidity, uint256 a0, uint256 a1)
    {
        mintCallCount++;
        lastMintTickLower = p.tickLower;
        lastMintTickUpper = p.tickUpper;
        tokenId   = nextTokenId++;
        liquidity = 500_000;
        a0 = p.amount0Desired / 2;
        a1 = p.amount1Desired / 2;

        // Simulate ERC-721 safeTransferFrom → vault.onERC721Received()
        (bool ok,) = p.recipient.call(
            abi.encodeWithSignature(
                "onERC721Received(address,address,uint256,bytes)",
                address(this), address(0), tokenId, ""
            )
        );
        require(ok, "MockNPM: onERC721Received failed");
    }

    function positions(uint256) external view returns (
        uint96, address, address, address, uint24,
        int24, int24, uint128, uint256, uint256, uint128, uint128
    ) {
        return (0, address(0), address(0), address(0), 3000,
                -600, 600, positionLiquidity, 0, 0, 0, 0);
    }

    function decreaseLiquidity(DecreaseLiquidityParams calldata)
        external returns (uint256, uint256)
    {
        decreaseLiquidityCallCount++;
        return (0, 0);
    }

    function collect(CollectParams calldata) external returns (uint256, uint256) {
        collectCallCount++;
        return (100e6, 0.05 ether);
    }

    function burn(uint256 tokenId_) external {
        burnCallCount++;
        lastBurnTokenId = tokenId_;
    }

    function setPositionLiquidity(uint128 liq) external { positionLiquidity = liq; }
    function setNextTokenId(uint256 id)         external { nextTokenId        = id; }
}

// ──────────────────────────────────────────────────────────────────────────────
//  MOCK — SOMNIA REACTIVITY PRECOMPILE
//  Etched at 0x0000000000000000000000000000000000000100 via vm.etch().
//  Returns incrementing subscription IDs.
// ──────────────────────────────────────────────────────────────────────────────
contract MockPrecompile {
    uint256 public nextSubId            = 1001;
    uint256 public unsubscribeCallCount;
    uint256 public lastUnsubscribedId;

    // SubscriptionData must match the struct layout in FluxVault exactly.
    struct SubscriptionData {
        bytes32[4] eventTopics;
        address origin; address caller; address emitter;
        address handlerContractAddress;
        bytes4  handlerFunctionSelector;
        uint64  priorityFeePerGas; uint64 maxFeePerGas; uint64 gasLimit;
        bool isGuaranteed; bool isCoalesced;
    }

    function subscribe(SubscriptionData calldata) external returns (uint256 subId) {
        subId = nextSubId++;
    }

    function unsubscribe(uint256 subId) external {
        unsubscribeCallCount++;
        lastUnsubscribedId = subId;
    }

    function getSubscriptionInfo(uint256) external pure
        returns (SubscriptionData memory d, address owner)
    {
        return (d, address(0));
    }
}


// ──────────────────────────────────────────────────────────────────────────────
//  FLUXVAULT TEST SUITE
// ──────────────────────────────────────────────────────────────────────────────
contract FluxVaultTest is Test {

    // ── Fixed addresses (match FluxVault constants) ───────────────────────────
    address constant PRECOMPILE_ADDR = 0x0000000000000000000000000000000000000100;
    address constant USDC_ADDR       = 0x28bec7e30e6faee657a03e19bf1128aad7632a00;
    address constant WETH_ADDR       = 0x936Ab8C674bcb567CD5dEB85D8A216494704E9D8;

    // ── Actors ────────────────────────────────────────────────────────────────
    address owner    = makeAddr("owner");
    address attacker = makeAddr("attacker");
    address stranger = makeAddr("stranger");

    // ── Mocks ─────────────────────────────────────────────────────────────────
    MockERC20      usdc;
    MockERC20      weth;
    MockPool       pool;
    MockNPM        npm;
    MockPrecompile precompile;

    // ── Subject ───────────────────────────────────────────────────────────────
    FluxVault vault;

    // ── Parameters ───────────────────────────────────────────────────────────
    int24   constant HALF_WIDTH   = 600;
    int24   constant TICK_SPACING = 60;
    uint256 constant STT_FUNDING  = 40 ether;


    // ─────────────────────────────────────────────────────────────────────────
    //  SET UP
    // ─────────────────────────────────────────────────────────────────────────

    function setUp() public {
        // 1. Deploy mocks to temporary addresses
        pool       = new MockPool();
        npm        = new MockNPM();
        precompile = new MockPrecompile();

        // 2. Etch mocks at the constant addresses the vault hardcodes
        vm.etch(PRECOMPILE_ADDR, address(precompile).code);
        vm.etch(USDC_ADDR,       address(new MockERC20()).code);
        vm.etch(WETH_ADDR,       address(new MockERC20()).code);

        // 3. Get typed handles to the etched addresses
        usdc = MockERC20(USDC_ADDR);
        weth = MockERC20(WETH_ADDR);

        // 4. Configure pool defaults: tick=0, TWAP=0 (no manipulation)
        pool.setCurrentTick(0);
        pool.setTwapTick(0);

        // 5. Deploy vault as owner
        vm.prank(owner);
        vault = new FluxVault(address(pool), address(npm), HALF_WIDTH, TICK_SPACING);

        // 6. Fund vault with STT for Reactivity subscription
        vm.deal(address(vault), STT_FUNDING);

        // 7. Seed vault with tokens for LP positions
        usdc.mint(address(vault), 1_000e6);
        weth.mint(address(vault), 1 ether);
    }


    // ═════════════════════════════════════════════════════════════════════════
    //  CONSTRUCTOR
    // ═════════════════════════════════════════════════════════════════════════

    function test_Constructor_SetsOwner() public {
        assertEq(vault.owner(), owner);
    }

    function test_Constructor_SetsPool() public {
        assertEq(vault.pool(), address(pool));
    }

    function test_Constructor_SetsNpm() public {
        assertEq(vault.npm(), address(npm));
    }

    function test_Constructor_ConfigPackedCorrectly() public {
        (int24 tl, int24 tu, int24 hw, int24 ts, uint24 fee, bool init, bool watching)
            = vault.config();
        assertEq(tl,    0);
        assertEq(tu,    0);
        assertEq(hw,    HALF_WIDTH);
        assertEq(ts,    TICK_SPACING);
        assertEq(fee,   3000);
        assertFalse(init);
        assertFalse(watching);
    }

    function test_Constructor_LockInitializedToOne() public {
        // _locked is at slot 5 (pre-factory layout). Must be 1 to avoid cold SSTORE.
        bytes32 raw = vm.load(address(vault), bytes32(uint256(5)));
        assertEq(uint256(raw), 1);
    }

    function test_Constructor_RevertZeroPool() public {
        vm.expectRevert(FluxVault.ZeroAddress.selector);
        new FluxVault(address(0), address(npm), HALF_WIDTH, TICK_SPACING);
    }

    function test_Constructor_RevertZeroNpm() public {
        vm.expectRevert(FluxVault.ZeroAddress.selector);
        new FluxVault(address(pool), address(0), HALF_WIDTH, TICK_SPACING);
    }

    function test_Constructor_RevertZeroHalfWidth() public {
        vm.expectRevert(FluxVault.InvalidTickRange.selector);
        new FluxVault(address(pool), address(npm), 0, TICK_SPACING);
    }

    function test_Constructor_RevertNegativeHalfWidth() public {
        vm.expectRevert(FluxVault.InvalidTickRange.selector);
        new FluxVault(address(pool), address(npm), -600, TICK_SPACING);
    }


    // ═════════════════════════════════════════════════════════════════════════
    //  onERC721Received
    // ═════════════════════════════════════════════════════════════════════════

    function test_OnERC721Received_ReturnsMagicSelector() public {
        bytes4 result = vault.onERC721Received(address(0), address(0), 0, "");
        assertEq(result, vault.onERC721Received.selector);
    }

    function test_OnERC721Received_AcceptsCallFromAnyone() public {
        // Must not revert regardless of caller
        vm.prank(attacker);
        bytes4 result = vault.onERC721Received(attacker, owner, 999, hex"1234");
        assertEq(result, vault.onERC721Received.selector);
    }


    // ═════════════════════════════════════════════════════════════════════════
    //  initializeFirstPosition
    // ═════════════════════════════════════════════════════════════════════════

    function test_InitFirstPosition_MintsNFT() public {
        vm.prank(owner);
        vault.initializeFirstPosition(1_000e6, 1 ether, 0, 0);
        assertEq(vault.tokenId(), 1);
    }

    function test_InitFirstPosition_SetsInitialized() public {
        vm.prank(owner);
        vault.initializeFirstPosition(1_000e6, 1 ether, 0, 0);
        (,,,,, bool init,) = vault.config();
        assertTrue(init);
    }

    function test_InitFirstPosition_TickRange_ZeroTick() public {
        // tick=0, halfWidth=600, spacing=60
        // lower = roundDown(0-600, 60) = -600
        // upper = roundUp(0+600, 60)   =  600
        vm.prank(owner);
        vault.initializeFirstPosition(1_000e6, 1 ether, 0, 0);
        (int24 tl, int24 tu,,,,,) = vault.config();
        assertEq(tl, -600);
        assertEq(tu,  600);
    }

    function test_InitFirstPosition_TickRange_PositiveTick() public {
        pool.setCurrentTick(300);
        vm.prank(owner);
        vault.initializeFirstPosition(1_000e6, 1 ether, 0, 0);
        (int24 tl, int24 tu,,,,,) = vault.config();
        // lower = roundDown(300-600=-300, 60) = -300
        // upper = roundUp(300+600=900, 60)    =  900
        assertEq(tl, -300);
        assertEq(tu,  900);
    }

    function test_InitFirstPosition_TickRange_NegativeTick() public {
        // Exercises the negative-tick branch in _roundDown
        pool.setCurrentTick(-100);
        vm.prank(owner);
        vault.initializeFirstPosition(1_000e6, 1 ether, 0, 0);
        (int24 tl, int24 tu,,,,,) = vault.config();
        // lower = roundDown(-700, 60): -700/60 = -11.67 → compressed=-11 → -1 = -12 → -720
        // upper = roundUp(500, 60):    500/60  =  8.33  → roundDown=480 → +60 = 540
        assertEq(tl, -720);
        assertEq(tu,  540);
    }

    function test_InitFirstPosition_EmitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit PositionInitialized(1, -600, 600);
        vm.prank(owner);
        vault.initializeFirstPosition(1_000e6, 1 ether, 0, 0);
    }

    function test_InitFirstPosition_RevertNotOwner() public {
        vm.prank(attacker);
        vm.expectRevert(FluxVault.NotOwner.selector);
        vault.initializeFirstPosition(1_000e6, 1 ether, 0, 0);
    }

    function test_InitFirstPosition_RevertAlreadyInitialized() public {
        vm.startPrank(owner);
        vault.initializeFirstPosition(1_000e6, 1 ether, 0, 0);
        vm.expectRevert(FluxVault.AlreadyInitialized.selector);
        vault.initializeFirstPosition(1_000e6, 1 ether, 0, 0);
        vm.stopPrank();
    }


    // ═════════════════════════════════════════════════════════════════════════
    //  startWatching
    // ═════════════════════════════════════════════════════════════════════════

    function test_StartWatching_SetsSubscriptionId() public {
        _initAndWatch();
        assertEq(vault.subscriptionId(), 1001);
    }

    function test_StartWatching_SetsWatchingTrue() public {
        _initAndWatch();
        (,,,,,, bool watching) = vault.config();
        assertTrue(watching);
    }

    function test_StartWatching_EmitsEvent() public {
        vm.prank(owner);
        vault.initializeFirstPosition(1_000e6, 1 ether, 0, 0);
        vm.expectEmit(true, false, false, false);
        emit WatchingStarted(1001);
        vm.prank(owner);
        vault.startWatching(3_000_000);
    }

    function test_StartWatching_RevertNotInitialized() public {
        vm.prank(owner);
        vm.expectRevert(FluxVault.NotInitialized.selector);
        vault.startWatching(3_000_000);
    }

    function test_StartWatching_RevertAlreadyWatching() public {
        _initAndWatch();
        vm.prank(owner);
        vm.expectRevert(FluxVault.AlreadyWatching.selector);
        vault.startWatching(3_000_000);
    }

    function test_StartWatching_RevertInsufficientSTT() public {
        vm.prank(owner);
        vault.initializeFirstPosition(1_000e6, 1 ether, 0, 0);
        vm.deal(address(vault), 10 ether); // below 32 STT minimum
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                FluxVault.InsufficientSTTBalance.selector,
                32 ether,
                10 ether
            )
        );
        vault.startWatching(3_000_000);
    }

    function test_StartWatching_RevertNotOwner() public {
        vm.prank(owner);
        vault.initializeFirstPosition(1_000e6, 1 ether, 0, 0);
        vm.prank(attacker);
        vm.expectRevert(FluxVault.NotOwner.selector);
        vault.startWatching(3_000_000);
    }


    // ═════════════════════════════════════════════════════════════════════════
    //  stopWatching
    // ═════════════════════════════════════════════════════════════════════════

    function test_StopWatching_ClearsSubscriptionId() public {
        _initAndWatch();
        vm.prank(owner);
        vault.stopWatching();
        assertEq(vault.subscriptionId(), 0);
    }

    function test_StopWatching_SetsWatchingFalse() public {
        _initAndWatch();
        vm.prank(owner);
        vault.stopWatching();
        (,,,,,, bool watching) = vault.config();
        assertFalse(watching);
    }

    function test_StopWatching_CallsPrecompileUnsubscribe() public {
        _initAndWatch();
        vm.prank(owner);
        vault.stopWatching();
        MockPrecompile mp = MockPrecompile(PRECOMPILE_ADDR);
        assertEq(mp.unsubscribeCallCount(), 1);
        assertEq(mp.lastUnsubscribedId(),   1001);
    }

    function test_StopWatching_RevertNotWatching() public {
        vm.prank(owner);
        vm.expectRevert(FluxVault.NotWatching.selector);
        vault.stopWatching();
    }

    function test_StopWatching_RevertNotOwner() public {
        _initAndWatch();
        vm.prank(attacker);
        vm.expectRevert(FluxVault.NotOwner.selector);
        vault.stopWatching();
    }


    // ═════════════════════════════════════════════════════════════════════════
    //  onEvent — ACCESS CONTROL
    // ═════════════════════════════════════════════════════════════════════════

    function test_OnEvent_RevertIfCallerNotPrecompile() public {
        _initAndWatch();
        vm.prank(attacker);
        vm.expectRevert(FluxVault.NotPrecompile.selector);
        vault.onEvent(address(pool), new bytes32[](0), _swapData(5000));
    }

    function test_OnEvent_RevertIfCallerIsOwner() public {
        _initAndWatch();
        vm.prank(owner);
        vm.expectRevert(FluxVault.NotPrecompile.selector);
        vault.onEvent(address(pool), new bytes32[](0), _swapData(5000));
    }


    // ═════════════════════════════════════════════════════════════════════════
    //  onEvent — SWAP PATH — IN RANGE
    // ═════════════════════════════════════════════════════════════════════════

    function test_OnEvent_Swap_InRange_NoRebalance() public {
        _initAndWatch();
        vm.prank(PRECOMPILE_ADDR);
        vault.onEvent(address(pool), new bytes32[](0), _swapData(100));
        assertEq(npm.mintCallCount(), 1); // only the init mint
    }

    function test_OnEvent_Swap_TickAtLowerBound_Inclusive_NoRebalance() public {
        _initAndWatch();
        // tickLower = -600 is INCLUSIVE (active range: tickLower ≤ tick < tickUpper)
        vm.prank(PRECOMPILE_ADDR);
        vault.onEvent(address(pool), new bytes32[](0), _swapData(-600));
        assertEq(npm.mintCallCount(), 1);
    }

    function test_OnEvent_Swap_TickOneBeforeUpper_NoRebalance() public {
        _initAndWatch();
        // tickUpper = 600 is EXCLUSIVE — tick = 599 is still in range
        vm.prank(PRECOMPILE_ADDR);
        vault.onEvent(address(pool), new bytes32[](0), _swapData(599));
        assertEq(npm.mintCallCount(), 1);
    }


    // ═════════════════════════════════════════════════════════════════════════
    //  onEvent — SWAP PATH — OUT OF RANGE (triggers rebalance)
    // ═════════════════════════════════════════════════════════════════════════

    function test_OnEvent_Swap_TickAboveUpper_Rebalances() public {
        _initAndWatch();
        pool.setTwapTick(5000); // TWAP matches — not a manipulation
        vm.prank(PRECOMPILE_ADDR);
        vault.onEvent(address(pool), new bytes32[](0), _swapData(5000));
        assertEq(npm.burnCallCount(), 1);
        assertEq(npm.mintCallCount(), 2); // 1 init + 1 rebalance
    }

    function test_OnEvent_Swap_TickBelowLower_Rebalances() public {
        _initAndWatch();
        pool.setTwapTick(-5000);
        vm.prank(PRECOMPILE_ADDR);
        vault.onEvent(address(pool), new bytes32[](0), _swapData(-5000));
        assertEq(npm.burnCallCount(), 1);
        assertEq(npm.mintCallCount(), 2);
    }

    function test_OnEvent_Swap_TickAtUpperBound_Exclusive_Rebalances() public {
        _initAndWatch();
        // tick = 600 = tickUpper → out of range (exclusive upper bound)
        pool.setTwapTick(600);
        vm.prank(PRECOMPILE_ADDR);
        vault.onEvent(address(pool), new bytes32[](0), _swapData(600));
        assertEq(npm.burnCallCount(), 1);
        assertEq(npm.mintCallCount(), 2);
    }

    function test_OnEvent_Swap_Rebalance_NewTickRangeCenteredOnNewTick() public {
        _initAndWatch();
        pool.setTwapTick(1200);
        vm.prank(PRECOMPILE_ADDR);
        vault.onEvent(address(pool), new bytes32[](0), _swapData(1200));
        (int24 tl, int24 tu,,,,,) = vault.config();
        // lower = roundDown(1200-600=600, 60) = 600
        // upper = roundUp(1200+600=1800, 60)  = 1800
        assertEq(tl, 600);
        assertEq(tu, 1800);
    }

    function test_OnEvent_Swap_Rebalance_UpdatesTokenId() public {
        _initAndWatch();
        uint256 oldId = vault.tokenId();
        pool.setTwapTick(5000);
        vm.prank(PRECOMPILE_ADDR);
        vault.onEvent(address(pool), new bytes32[](0), _swapData(5000));
        assertTrue(vault.tokenId() > oldId);
    }

    function test_OnEvent_Swap_Rebalance_EmitsRebalanced() public {
        _initAndWatch();
        uint256 oldId = vault.tokenId();
        pool.setTwapTick(5000);
        vm.expectEmit(true, false, false, true);
        emit Rebalanced(5000, oldId, oldId + 1);
        vm.prank(PRECOMPILE_ADDR);
        vault.onEvent(address(pool), new bytes32[](0), _swapData(5000));
    }

    function test_OnEvent_Swap_Rebalance_CallsDecreaseCollectBurn() public {
        _initAndWatch();
        pool.setTwapTick(5000);
        vm.prank(PRECOMPILE_ADDR);
        vault.onEvent(address(pool), new bytes32[](0), _swapData(5000));
        assertEq(npm.decreaseLiquidityCallCount(), 1);
        assertEq(npm.collectCallCount(),           1);
        assertEq(npm.burnCallCount(),              1);
    }

    function test_OnEvent_Swap_Rebalance_SkipsDecrease_WhenPositionEmpty() public {
        _initAndWatch();
        npm.setPositionLiquidity(0); // simulate already drained position
        pool.setTwapTick(5000);
        vm.prank(PRECOMPILE_ADDR);
        vault.onEvent(address(pool), new bytes32[](0), _swapData(5000));
        // decreaseLiquidity guarded by `if (liquidity > 0)`
        assertEq(npm.decreaseLiquidityCallCount(), 0);
        assertEq(npm.collectCallCount(),           1);
        assertEq(npm.burnCallCount(),              1);
    }

    function test_OnEvent_Swap_MultipleRebalances_InSequence() public {
        _initAndWatch();

        // First rebalance: tick → 5000
        pool.setTwapTick(5000);
        vm.prank(PRECOMPILE_ADDR);
        vault.onEvent(address(pool), new bytes32[](0), _swapData(5000));
        assertEq(npm.mintCallCount(), 2);

        // Second rebalance: tick → -5000
        pool.setTwapTick(-5000);
        vm.prank(PRECOMPILE_ADDR);
        vault.onEvent(address(pool), new bytes32[](0), _swapData(-5000));
        assertEq(npm.mintCallCount(), 3);
        assertEq(npm.burnCallCount(), 2);
    }


    // ═════════════════════════════════════════════════════════════════════════
    //  onEvent — BLOCKTICK PATH
    // ═════════════════════════════════════════════════════════════════════════

    function test_OnEvent_BlockTick_InRange_NoRebalance() public {
        _initAndWatch();
        pool.setCurrentTick(0); // in range [-600, 600]
        _rollBlocks(100);
        vm.prank(PRECOMPILE_ADDR);
        vault.onEvent(PRECOMPILE_ADDR, new bytes32[](0), "");
        assertEq(npm.mintCallCount(), 1);
    }

    function test_OnEvent_BlockTick_OutOfRange_Rebalances() public {
        _initAndWatch();
        pool.setCurrentTick(5000);
        pool.setTwapTick(5000);
        _rollBlocks(100);
        vm.prank(PRECOMPILE_ADDR);
        vault.onEvent(PRECOMPILE_ADDR, new bytes32[](0), "");
        assertEq(npm.mintCallCount(), 2);
        assertEq(npm.burnCallCount(), 1);
    }

    function test_OnEvent_BlockTick_IntervalGuard_TooEarly_Skips() public {
        _initAndWatch();
        pool.setCurrentTick(5000);
        pool.setTwapTick(5000);
        _rollBlocks(10); // below BACKUP_CHECK_INTERVAL (50)
        vm.prank(PRECOMPILE_ADDR);
        vault.onEvent(PRECOMPILE_ADDR, new bytes32[](0), "");
        assertEq(npm.mintCallCount(), 1); // skipped
    }

    function test_OnEvent_BlockTick_IntervalGuard_EnoughBlocks_Fires() public {
        _initAndWatch();
        pool.setCurrentTick(5000);
        pool.setTwapTick(5000);
        _rollBlocks(51); // past BACKUP_CHECK_INTERVAL
        vm.prank(PRECOMPILE_ADDR);
        vault.onEvent(PRECOMPILE_ADDR, new bytes32[](0), "");
        assertEq(npm.mintCallCount(), 2);
    }

    function test_OnEvent_BlockTick_UpdatesLastBackupCheckBlock() public {
        _initAndWatch();
        _rollBlocks(100);
        vm.prank(PRECOMPILE_ADDR);
        vault.onEvent(PRECOMPILE_ADDR, new bytes32[](0), "");
        assertEq(vault.lastBackupCheckBlock(), block.number);
    }

    function test_OnEvent_BlockTick_SecondCallTooEarly_Skips() public {
        _initAndWatch();
        pool.setCurrentTick(5000);
        pool.setTwapTick(5000);

        // First call fires
        _rollBlocks(100);
        vm.prank(PRECOMPILE_ADDR);
        vault.onEvent(PRECOMPILE_ADDR, new bytes32[](0), "");
        assertEq(npm.mintCallCount(), 2);

        // Second call immediately after — should be skipped
        vm.prank(PRECOMPILE_ADDR);
        vault.onEvent(PRECOMPILE_ADDR, new bytes32[](0), "");
        assertEq(npm.mintCallCount(), 2); // no additional rebalance
    }


    // ═════════════════════════════════════════════════════════════════════════
    //  TWAP GUARD
    // ═════════════════════════════════════════════════════════════════════════

    function test_TWAP_BlocksRebalance_WhenDeviationAboveMax() public {
        _initAndWatch();
        pool.setTwapTick(0); // TWAP = 0, swap tick = 5000, deviation = 5000 > 600
        vm.prank(PRECOMPILE_ADDR);
        vault.onEvent(address(pool), new bytes32[](0), _swapData(5000));
        assertEq(npm.mintCallCount(), 1); // blocked
        assertEq(npm.burnCallCount(), 0);
    }

    function test_TWAP_AllowsRebalance_WhenDeviationWithinMax() public {
        _initAndWatch();
        pool.setTwapTick(900); // TWAP=900, swap tick=1200, deviation=300 < 600
        vm.prank(PRECOMPILE_ADDR);
        vault.onEvent(address(pool), new bytes32[](0), _swapData(1200));
        assertEq(npm.mintCallCount(), 2);
    }

    function test_TWAP_AllowsRebalance_WhenDeviationExactlyAtMax() public {
        _initAndWatch();
        // TWAP=0, tick=600, deviation=600 == MAX_TICK_DEVIATION
        // guard is `deviation > MAX` so exact boundary is allowed
        pool.setTwapTick(0);
        vm.prank(PRECOMPILE_ADDR);
        vault.onEvent(address(pool), new bytes32[](0), _swapData(600));
        assertEq(npm.mintCallCount(), 2);
    }

    function test_TWAP_FailsOpen_WhenObserveReverts() public {
        _initAndWatch();
        pool.setTwapShouldRevert(true);
        // Without TWAP data the vault should still rebalance (fail open)
        vm.prank(PRECOMPILE_ADDR);
        vault.onEvent(address(pool), new bytes32[](0), _swapData(5000));
        assertEq(npm.mintCallCount(), 2);
    }

    function test_TWAP_HandlesNegativeDeviation() public {
        _initAndWatch();
        // TWAP = 0, swap tick = -5000, abs deviation = 5000 > 600 → blocked
        pool.setTwapTick(0);
        vm.prank(PRECOMPILE_ADDR);
        vault.onEvent(address(pool), new bytes32[](0), _swapData(-5000));
        assertEq(npm.mintCallCount(), 1); // blocked
    }

    function test_TWAP_NegativeTwap_PositiveSwapTick_Blocked() public {
        _initAndWatch();
        pool.setTwapTick(-500);
        // deviation = abs(5000 - (-500)) = 5500 > 600 → blocked
        vm.prank(PRECOMPILE_ADDR);
        vault.onEvent(address(pool), new bytes32[](0), _swapData(5000));
        assertEq(npm.mintCallCount(), 1);
    }


    // ═════════════════════════════════════════════════════════════════════════
    //  ADMIN — setHalfWidth
    // ═════════════════════════════════════════════════════════════════════════

    function test_SetHalfWidth_UpdatesConfig() public {
        vm.prank(owner);
        vault.setHalfWidth(1200);
        (,, int24 hw,,,,) = vault.config();
        assertEq(hw, 1200);
    }

    function test_SetHalfWidth_AffectsNextRebalance() public {
        _initAndWatch();
        vm.prank(owner);
        vault.setHalfWidth(1200);
        pool.setTwapTick(5000);
        vm.prank(PRECOMPILE_ADDR);
        vault.onEvent(address(pool), new bytes32[](0), _swapData(5000));
        (int24 tl, int24 tu,,,,,) = vault.config();
        // lower = roundDown(5000-1200=3800, 60) = 3780
        // upper = roundUp(5000+1200=6200, 60): 6200/60=103.3 → 103*60=6180 → +60=6240
        assertEq(tl, 3780);
        assertEq(tu, 6240);
    }

    function test_SetHalfWidth_RevertNotOwner() public {
        vm.prank(attacker);
        vm.expectRevert(FluxVault.NotOwner.selector);
        vault.setHalfWidth(1200);
    }

    function test_SetHalfWidth_RevertZero() public {
        vm.prank(owner);
        vm.expectRevert(FluxVault.InvalidTickRange.selector);
        vault.setHalfWidth(0);
    }

    function test_SetHalfWidth_RevertNegative() public {
        vm.prank(owner);
        vm.expectRevert(FluxVault.InvalidTickRange.selector);
        vault.setHalfWidth(-600);
    }


    // ═════════════════════════════════════════════════════════════════════════
    //  ADMIN — withdrawSTT
    // ═════════════════════════════════════════════════════════════════════════

    function test_WithdrawSTT_TransfersToOwner() public {
        uint256 before = owner.balance;
        vm.prank(owner);
        vault.withdrawSTT(10 ether);
        assertEq(owner.balance, before + 10 ether);
    }

    function test_WithdrawSTT_ReducesVaultBalance() public {
        vm.prank(owner);
        vault.withdrawSTT(10 ether);
        assertEq(address(vault).balance, STT_FUNDING - 10 ether);
    }

    function test_WithdrawSTT_RevertNotOwner() public {
        vm.prank(attacker);
        vm.expectRevert(FluxVault.NotOwner.selector);
        vault.withdrawSTT(10 ether);
    }


    // ═════════════════════════════════════════════════════════════════════════
    //  ADMIN — rescueTokens
    // ═════════════════════════════════════════════════════════════════════════

    function test_RescueTokens_USDC_TransfersToOwner() public {
        vm.prank(owner);
        vault.rescueTokens(USDC_ADDR, 500e6);
        assertEq(usdc.balanceOf(owner), 500e6);
    }

    function test_RescueTokens_WETH_TransfersToOwner() public {
        vm.prank(owner);
        vault.rescueTokens(WETH_ADDR, 0.5 ether);
        assertEq(weth.balanceOf(owner), 0.5 ether);
    }

    function test_RescueTokens_RevertNotOwner() public {
        vm.prank(attacker);
        vm.expectRevert(FluxVault.NotOwner.selector);
        vault.rescueTokens(USDC_ADDR, 500e6);
    }


    // ═════════════════════════════════════════════════════════════════════════
    //  ADMIN — transferOwnership
    // ═════════════════════════════════════════════════════════════════════════

    function test_TransferOwnership_UpdatesOwner() public {
        vm.prank(owner);
        vault.transferOwnership(stranger);
        assertEq(vault.owner(), stranger);
    }

    function test_TransferOwnership_NewOwnerCanCallAdmin() public {
        vm.prank(owner);
        vault.transferOwnership(stranger);
        vm.prank(stranger);
        vault.setHalfWidth(1200); // should not revert
        (,, int24 hw,,,,) = vault.config();
        assertEq(hw, 1200);
    }

    function test_TransferOwnership_OldOwnerLosesAccess() public {
        vm.prank(owner);
        vault.transferOwnership(stranger);
        vm.prank(owner);
        vm.expectRevert(FluxVault.NotOwner.selector);
        vault.setHalfWidth(1200);
    }

    function test_TransferOwnership_RevertZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(FluxVault.ZeroAddress.selector);
        vault.transferOwnership(address(0));
    }

    function test_TransferOwnership_RevertNotOwner() public {
        vm.prank(attacker);
        vm.expectRevert(FluxVault.NotOwner.selector);
        vault.transferOwnership(stranger);
    }


    // ═════════════════════════════════════════════════════════════════════════
    //  sttBalance + receive()
    // ═════════════════════════════════════════════════════════════════════════

    function test_SttBalance_ReturnsCorrectBalance() public {
        assertEq(vault.sttBalance(), STT_FUNDING);
    }

    function test_Receive_AcceptsSTT() public {
        vm.deal(stranger, 5 ether);
        vm.prank(stranger);
        (bool ok,) = address(vault).call{value: 5 ether}("");
        assertTrue(ok);
        assertEq(address(vault).balance, STT_FUNDING + 5 ether);
    }


    // ═════════════════════════════════════════════════════════════════════════
    //  FUZZ — tick math
    // ═════════════════════════════════════════════════════════════════════════

    /// @dev Tick range must always be aligned to tickSpacing and lower < upper.
    function testFuzz_TickRange_AlwaysAligned(int24 tick) public {
        tick = int24(bound(tick, -800_000, 800_000));
        pool.setCurrentTick(tick);
        pool.setTwapTick(tick);
        vm.prank(owner);
        vault.initializeFirstPosition(1_000e6, 1 ether, 0, 0);
        (int24 tl, int24 tu,,,,,) = vault.config();
        assertEq(tl % TICK_SPACING, 0, "tickLower not aligned");
        assertEq(tu % TICK_SPACING, 0, "tickUpper not aligned");
        assertTrue(tl < tu,             "tickLower must be < tickUpper");
    }

    /// @dev After an out-of-range rebalance, the new range must contain newTick.
    function testFuzz_Rebalance_NewRangeContainsTick(int24 newTick) public {
        newTick = int24(bound(newTick, 700, 800_000)); // force out of initial range
        _initAndWatch();
        pool.setTwapTick(newTick); // no manipulation
        vm.prank(PRECOMPILE_ADDR);
        vault.onEvent(address(pool), new bytes32[](0), _swapData(newTick));
        (int24 tl, int24 tu,,,,,) = vault.config();
        assertTrue(newTick >= tl, "newTick below tickLower after rebalance");
        assertTrue(newTick <  tu, "newTick above tickUpper after rebalance");
    }

    /// @dev Negative out-of-range rebalances should also contain the new tick.
    function testFuzz_Rebalance_NegativeTick_NewRangeContainsTick(int24 newTick) public {
        newTick = int24(bound(newTick, -800_000, -700)); // force below initial range
        _initAndWatch();
        pool.setTwapTick(newTick);
        vm.prank(PRECOMPILE_ADDR);
        vault.onEvent(address(pool), new bytes32[](0), _swapData(newTick));
        (int24 tl, int24 tu,,,,,) = vault.config();
        assertTrue(newTick >= tl, "newTick below tickLower after rebalance");
        assertTrue(newTick <  tu, "newTick above tickUpper after rebalance");
    }


    // ═════════════════════════════════════════════════════════════════════════
    //  INTERNAL HELPERS
    // ═════════════════════════════════════════════════════════════════════════

    /// @dev Encodes non-indexed Swap event fields as they arrive in onEvent data.
    ///      Swap(address indexed, address indexed, int256, int256, uint160, uint128, int24)
    ///      Only the last 5 fields are in `data`.
    function _swapData(int24 tick) internal pure returns (bytes memory) {
        return abi.encode(
            int256(1_000e6),
            int256(-0.5 ether),
            uint160(79228162514264337593543950336),
            uint128(1_000_000),
            tick
        );
    }

    /// @dev Initialises first position and starts watching. Used in most tests.
    function _initAndWatch() internal {
        vm.startPrank(owner);
        vault.initializeFirstPosition(1_000e6, 1 ether, 0, 0);
        vault.startWatching(3_000_000);
        vm.stopPrank();
    }

    /// @dev Rolls block.number forward by n.
    function _rollBlocks(uint256 n) internal {
        vm.roll(block.number + n);
    }


    // ═════════════════════════════════════════════════════════════════════════
    //  EVENT DECLARATIONS — required by vm.expectEmit
    // ═════════════════════════════════════════════════════════════════════════

    event Rebalanced(int24 indexed newTick, uint256 oldTokenId, uint256 newTokenId);
    event PositionInitialized(uint256 indexed tokenId, int24 tickLower, int24 tickUpper);
    event WatchingStarted(uint256 indexed subscriptionId);
    event WatchingStopped(uint256 indexed subscriptionId);
}
