import { keccak256, toBytes } from 'viem';
const errors = [
  'NotOwner()',
  'ZeroAddress()',
  'UnsupportedFeeTier(uint24)',
  'VaultAlreadyExists(address,address)',
  'InvalidTokenOrder()',
  'TokenTransferFailed()',
  'InsufficientSTTFunding(uint256,uint256)',
  'InsufficientAllowance(address,uint256,uint256)',
  'STTTransferFailed()',
  'NotPrecompile()',
  'AlreadyInitialized()',
  'NotInitialized()',
  'AlreadyWatching()',
  'NotWatching()',
  'InvalidTickRange()',
  'BackupAlreadyWatching()',
  'BackupNotWatching()',
  'InsufficientSTTBalance(uint256,uint256)',
  'Reentrancy()',
];
const TARGET = '0x192b9e4e';
let found = false;
errors.forEach(e => {
  const sel = keccak256(toBytes(e)).slice(0, 10);
  if (sel === TARGET) { console.log('MATCH:', sel, '=', e); found = true; }
  else { console.log(sel, '=', e); }
});
if (!found) console.log('\nNo match found for', TARGET);
