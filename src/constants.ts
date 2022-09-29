import { Network } from "./types";

export const NULL_ADDRESS = "0x0000000000000000000000000000000000000000";
export const NULL_BLOCK_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
export const OPENSEA_FEE_RECIPIENT =
  "0x0000a26b00c1f0df003000390027140000faa719";
export const INVERSE_BASIS_POINT = 10_000; // 100 basis points per 1%
export const SHARED_STOREFRONT_LAZY_MINT_ADAPTER_ADDRESS =
  "0xa604060890923ff400e8c6f5290461a83aedacec"; // Same address on mainnet and Rinkeby
export const SHARED_STORE_FRONT_ADDRESS_MAINNET =
  "0x495f947276749ce646f68ac8c248420045cb7b5e";
export const SHARED_STORE_FRONT_ADDRESS_RINKEBY =
  "0x88b48f654c30e99bc2e4a1559b4dcf1ad93fa656";
export const DEFAULT_SELLER_FEE_BASIS_POINTS = 250;
export const MAX_EXPIRATION_MONTHS = 3;
const ORDERBOOK_VERSION = 1 as number;
export const API_BASE_MAINNET = "https://api.opensea.io";
export const API_BASE_TESTNET = "https://testnets-api.opensea.io";
export const API_PATH = `/api/v${ORDERBOOK_VERSION}`;

export const CROSS_CHAIN_DEFAULT_CONDUIT_KEY =
  "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000";
const CROSS_CHAIN_DEFAULT_CONDUIT =
  "0x1e0049783f008a0085193e00003d00cd54003c71";

export const CONDUIT_KEYS_TO_CONDUIT = {
  [CROSS_CHAIN_DEFAULT_CONDUIT_KEY]: CROSS_CHAIN_DEFAULT_CONDUIT,
};

export const WETH_ADDRESS_BY_NETWORK = {
  [Network.Main]: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  [Network.Rinkeby]: "0xc778417e063141139fce010982780140aa0cd5ab",
  [Network.Goerli]: "0xb4fbf271143f4fbf7b91a5ded31805e42b2208d6",
} as const;

export const DEFAULT_ZONE_BY_NETWORK = {
  [Network.Main]: "0x004c00500000ad104d7dbd00e3ae0a5c00560c00",
  [Network.Rinkeby]: "0x00000000e88fe2628ebc5da81d2b3cead633e89e",
  [Network.Goerli]: "0x0000000000000000000000000000000000000000",
} as const;
