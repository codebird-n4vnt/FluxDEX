// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

struct SubscriptionData {
    bytes32[4] eventTopics;
    address origin;
    address caller;
    address emitter;
    address handlerContractAddress;
    bytes4 handlerFunctionSelector;
    uint64 priorityFeePerGas;
    uint64 maxFeePerGas;
    uint64 gasLimit;
    bool isGuaranteed;
    bool isCoalesced;
}

interface ISomniaReactivityPrecompile{
    function subscribe(SubscriptionData calldata subscriptionData) external returns(uint256 subscriptionId);
}

// interface SomniaEventHandler{
//     function _onEvent(
//         address emitter,
//         bytes32[] calldata eventTopics,
//         bytes calldata data
//     ) internal override{

//     }
// }

contract FluxDEX{

    address public constant SOMNIA_REACTIVITY_PRECOMPILE = 0x0000000000000000000000000000000000000100;
    bytes32 public constant SWAP_EVENT_TOPIC = 0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67;

    address public owner;

    uint256 public subscriptionId;

    constructor(){
        owner = msg.sender;
    }

    function startWatching(address _targetPool) external{
        bytes32[4] memory topics;
        topics[0] = SWAP_EVENT_TOPIC;
        topics[1] = bytes32(0);
        topics[2] = bytes32(0);
        topics[3] = bytes32(0);

        SubscriptionData memory subData = SubscriptionData({
            eventTopics: topics,
            origin: address(0),     
            caller: address(0),     
            emitter: _targetPool,    
            handlerContractAddress: address(this),
            handlerFunctionSelector: this.onEvent.selector,
            priorityFeePerGas: 1 gwei,
            maxFeePerGas: 10 gwei,
            gasLimit: 500000,      
            isGuaranteed: false,
            isCoalesced: false
        });

        ISomniaReactivityPrecompile(SOMNIA_REACTIVITY_PRECOMPILE).subscribe();
    }


}