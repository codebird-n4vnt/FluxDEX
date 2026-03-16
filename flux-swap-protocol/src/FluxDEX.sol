// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {console} "forge-std/console.sol";

interface INonfungiblePositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24  fee;
        int24   tickLower;
        int24   tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }
    function mint(MintParams calldata params)
        external payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);

    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }
    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external payable
        returns (uint256 amount0, uint256 amount1);

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }
    function collect(CollectParams calldata params)
        external payable
        returns (uint256 amount0, uint256 amount1);
}

interface IUniswapV3Pool {
    function slot0()
        external view
        returns (
            uint160 sqrtPriceX96,
            int24   tick,
            uint16  observationIndex,
            uint16  observationCardinality,
            uint16  observationCardinalityNext,
            uint8   feeProtocol,
            bool    unlocked
        );
}

struct SubscriptionData {
    bytes32[4] eventTopics;
    address    origin;
    address    caller;
    address    emitter;
    address    handlerContractAddress;
    bytes4     handlerFunctionSelector;
    uint64     priorityFeePerGas;
    uint64     maxFeePerGas;
    uint64     gasLimit;
    bool       isGuaranteed;
    bool       isCoalesced;
}

interface ISomniaReactivityPrecompile {
    function subscribe(SubscriptionData calldata subscriptionData)
        external returns (uint256 subscriptionId);
}

interface IERC20 {
    function approve(address spender, uint256 amount)  external returns (bool);
    function balanceOf(address account)                external view returns (uint256);
    function transfer(address to, uint256 amount)      external returns (bool);
}

contract FluxDEX {

    address public constant SOMNIA_REACTIVITY_PRECOMPILE = 0x0000000000000000000000000000000000000100;

    bytes32 public constant SWAP_EVENT_TOPIC =
        0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67;

    int24  public constant TICK_SPACING = 60;   // matches the 0.3% fee tier
    int24  public constant RANGE_TICKS  = 10;   // +/- 10 tick-spacings around current tick
    uint24 public constant POOL_FEE     = 3000; // 0.3%


    INonfungiblePositionManager public immutable positionManager;
    address public immutable token0; 
    address public immutable token1; 


    address public owner;
    address public targetPool;     

    uint256 public subscriptionId;
    uint256 public currentTokenId;
    uint128 public currentLiquidity;
    int24   public currentTickLower;
    int24   public currentTickUpper;

    event VaultInitialized(int24 tickLower, int24 tickUpper, uint256 tokenId, uint128 liquidity);
    event Rebalanced(int24 indexed tickLower, int24 indexed tickUpper, uint256 tokenId, uint128 liquidity);
    event Subscribed(address indexed pool, uint256 subscriptionId);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "FluxDEX: not owner");
        _;
    }

    modifier onlyPrecompile() {
        require(
            msg.sender == SOMNIA_REACTIVITY_PRECOMPILE,
            "FluxDEX: caller is not the reactivity precompile"
        );
        _;
    }

    constructor(
        address _positionManager,
        address _token0,
        address _token1,
        address _targetPool
    ) {
        require(_positionManager != address(0), "FluxDEX: zero positionManager");
        require(_token0 != address(0), "FluxDEX: zero token0");
        require(_token1 != address(0), "FluxDEX: zero token1");
        require(_token0 != _token1,    "FluxDEX: identical tokens");
        require(_targetPool != address(0), "FluxDEX: zero pool");
        require(_token0 < _token1,              "FluxDEX: token0 must be < token1");

        owner           = msg.sender;
        positionManager = INonfungiblePositionManager(_positionManager);
        token0          = _token0;
        token1          = _token1;
        targetPool      = _targetPool;
    }

    receive() external payable {}

    function initializeFirstPosition() external onlyOwner {
        require(currentLiquidity == 0, "FluxDEX: vault already has an active position");

        (, int24 startingTick, , , , , ) = IUniswapV3Pool(targetPool).slot0();

        console.log("Kickstarting vault. Current pool tick:");
        console.logInt(startingTick);

        _rebalance(startingTick);

        emit VaultInitialized(currentTickLower, currentTickUpper, currentTokenId, currentLiquidity);
        console.log("Vault initialized and ready for reactivity!");
    }

    function startWatching() external onlyOwner {
        bytes32[4] memory topics;
        topics[0] = SWAP_EVENT_TOPIC;
        // topics[1..3] = 0 -> match any sender / recipient

        SubscriptionData memory subData = SubscriptionData({
            eventTopics:             topics,
            origin:                  address(0),
            caller:                  address(0),
            emitter:                 targetPool,
            handlerContractAddress:  address(this),
            handlerFunctionSelector: this.onEvent.selector,
            priorityFeePerGas:       1 gwei,
            maxFeePerGas:            10 gwei,
            gasLimit:                500_000,
            isGuaranteed:            false,
            isCoalesced:             false
        });

        subscriptionId = ISomniaReactivityPrecompile(SOMNIA_REACTIVITY_PRECOMPILE)
            .subscribe(subData);

        emit Subscribed(targetPool, subscriptionId);
    }

    function onEvent(
        address emitter,
        bytes32[] calldata eventTopics,
        bytes calldata data
    ) external onlyPrecompile {
        emitter; // suppress unused-variable warning; kept for interface compliance

        address swapSender = address(uint160(uint256(eventTopics[1])));

        (
            int256  amount0,
            int256  amount1,
            uint160 sqrtPriceX96,
            uint128 poolLiquidity,
            int24   tick
        ) = abi.decode(data, (int256, int256, uint160, uint128, int24));

        // Suppress unused local warnings for decoded fields not used in logic
        amount0; amount1; sqrtPriceX96; poolLiquidity;

        console.log("Swap detected. Sender:");
        console.log(swapSender);
        console.log("New pool tick:");
        console.logInt(tick);

        if (tick < currentTickLower || tick > currentTickUpper) {
            console.log("Tick out of range - executing rebalance...");
            _rebalance(tick);
        }
    }

    function _rebalance(int24 currentTick) internal {

        if (currentLiquidity > 0) {
            positionManager.decreaseLiquidity(
                INonfungiblePositionManager.DecreaseLiquidityParams({
                    tokenId:currentTokenId,
                    liquidity:currentLiquidity,
                    amount0Min:0,
                    amount1Min:0,
                    deadline:block.timestamp
                })
            );

            positionManager.collect(
                INonfungiblePositionManager.CollectParams({
                    tokenId:    currentTokenId,
                    recipient:  address(this),
                    amount0Max: type(uint128).max,
                    amount1Max: type(uint128).max
                })
            );

            currentLiquidity = 0;
        }

        int24 nearestTick = (currentTick / TICK_SPACING) * TICK_SPACING;
        currentTickLower  = nearestTick - (TICK_SPACING * RANGE_TICKS);
        currentTickUpper  = nearestTick + (TICK_SPACING * RANGE_TICKS);

        uint256 balance0 = IERC20(token0).balanceOf(address(this));
        uint256 balance1 = IERC20(token1).balanceOf(address(this));

        require(balance0 > 0 || balance1 > 0, "FluxDEX: no tokens to deposit");

        IERC20(token0).approve(address(positionManager), balance0);
        IERC20(token1).approve(address(positionManager), balance1);

        (uint256 newTokenId, uint128 newLiquidity, , ) = positionManager.mint(
            INonfungiblePositionManager.MintParams({
                token0:         token0,
                token1:         token1,
                fee:            POOL_FEE,
                tickLower:      currentTickLower,
                tickUpper:      currentTickUpper,
                amount0Desired: balance0,
                amount1Desired: balance1,
                amount0Min:     0, // see slippage note above
                amount1Min:     0,
                recipient:      address(this),
                deadline:       block.timestamp
            })
        );

        IERC20(token0).approve(address(positionManager), 0);
        IERC20(token1).approve(address(positionManager), 0);

        currentTokenId   = newTokenId;
        currentLiquidity = newLiquidity;

        emit Rebalanced(currentTickLower, currentTickUpper, newTokenId, newLiquidity);
        console.log("Rebalanced. New position ID:", currentTokenId);
    }

    function withdrawToken(address token, address to, uint256 amount) external onlyOwner {
        require(to != address(0), "FluxDEX: zero recipient");
        uint256 bal = IERC20(token).balanceOf(address(this));
        uint256 out = amount > bal ? bal : amount;
        require(out > 0, "FluxDEX: nothing to withdraw");
        require(IERC20(token).transfer(to, out), "FluxDEX: transfer failed");
        emit Withdrawn(token, to, out);
    }

    function withdrawETH(address payable to) external onlyOwner {
        require(to != address(0), "FluxDEX: zero recipient");
        uint256 bal = address(this).balance;
        require(bal > 0, "FluxDEX: no ETH balance");
        (bool ok, ) = to.call{value: bal}("");
        require(ok, "FluxDEX: ETH transfer failed");
    }

    function setTargetPool(address _newPool) external onlyOwner {
        require(_newPool != address(0), "FluxDEX: zero pool");
        targetPool = _newPool;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "FluxDEX: zero address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}