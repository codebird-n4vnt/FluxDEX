
import { createConfig, http } from 'wagmi'
import { somniaTestnet } from 'wagmi/chains'

export const config = createConfig({
  chains: [somniaTestnet],
  transports: {
    [somniaTestnet.id]:http(),
  },
})
