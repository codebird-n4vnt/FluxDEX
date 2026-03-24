// src/types/index.ts

export interface Token {
  address: string;
  symbol: string;
  name?: string;
  decimals: number;
  logoURI?: string;
}

export interface LiveData {
  currentTick?: number;
  sqrtPriceX96?: string;
  price?: number;
  priceLabel?: string;
  tickLower?: number;
  tickUpper?: number;
  halfWidth?: number;
  watching?: boolean;
  initialized?: boolean;
  sttBalance?: string;
  poolBalance0?: string;
  poolBalance1?: string;
  lastUpdated?: number;
}

export interface RebalanceEvent {
  newTick: number;
  oldTokenId: number | string;
  newTokenId: number | string;
  txHash?: string;
  blockNumber: number;
  timestamp: number;
  poolAddress?: string;
  vaultAddress?: string;
}

export interface Pool {
  poolAddress: string;
  vaultAddress?: string;
  token0: Token;
  token1: Token;
  fee: number;
  deployer?: string;
  createdAt?: number;
  liveData?: LiveData;
  recentRebalances?: RebalanceEvent[];
}