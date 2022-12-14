import { ItemType } from "@opensea/seaport-js/lib/constants";
import BigNumber from "bignumber.js";
import { ethers } from "ethers";
import {
  INVERSE_BASIS_POINT,
  MAX_EXPIRATION_MONTHS,
  NULL_ADDRESS,
  NULL_BLOCK_HASH,
  SHARED_STOREFRONT_LAZY_MINT_ADAPTER_ADDRESS,
  SHARED_STORE_FRONT_ADDRESS_MAINNET,
  SHARED_STORE_FRONT_ADDRESS_RINKEBY,
} from "../constants";
import {
  AssetEvent,
  OpenSeaAccount,
  OpenSeaAsset,
  OpenSeaAssetBundle,
  OpenSeaAssetContract,
  OpenSeaCollection,
  OpenSeaFungibleToken,
  OpenSeaTraitStats,
  OpenSeaUser,
  Order,
  OrderJSON,
  OrderSide,
  SaleKind,
  Transaction,
  TxnCallback,
  SchemaName,
} from "../types";

// OTHER

const txCallbacks: { [key: string]: TxnCallback[] } = {};

const track = (
  provider: ethers.providers.Provider,
  txHash: string,
  onFinalized: TxnCallback
) => {
  if (txCallbacks[txHash]) {
    txCallbacks[txHash].push(onFinalized);
  } else {
    txCallbacks[txHash] = [onFinalized];
    const poll = async () => {
      const tx = await provider.getTransaction(txHash);
      if (tx && tx.blockHash && tx.blockHash !== NULL_BLOCK_HASH) {
        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt) {
          // Hack: assume success if no receipt
          console.warn("No receipt found for ", txHash);
        }
        const status = receipt.status;
        txCallbacks[txHash].map((f) => f(!!status));
        delete txCallbacks[txHash];
      } else {
        setTimeout(poll, 1000);
      }
    };
    poll().catch();
  }
};

export const confirmTransaction = async (
  provider: ethers.providers.Provider,
  txHash: string
) => {
  return new Promise((resolve, reject) => {
    track(provider, txHash, (didSucceed: boolean) => {
      if (didSucceed) {
        resolve("Transaction complete!");
      } else {
        reject(
          new Error(
            `Transaction failed :( You might have already completed this action. See more on the mainnet at etherscan.io/tx/${txHash}`
          )
        );
      }
    });
  });
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const assetFromJSON = (asset: any): OpenSeaAsset => {
  const isAnimated = asset.image_url && asset.image_url.endsWith(".gif");
  const isSvg = asset.image_url && asset.image_url.endsWith(".svg");
  const fromJSON: OpenSeaAsset = {
    tokenId: asset.token_id.toString(),
    tokenAddress: asset.asset_contract.address,
    name: asset.name,
    description: asset.description,
    owner: asset.owner,
    assetContract: assetContractFromJSON(asset.asset_contract),
    collection: collectionFromJSON(asset.collection),
    orders: asset.orders ? asset.orders.map(orderFromJSON) : null,
    sellOrders: asset.sell_orders ? asset.sell_orders.map(orderFromJSON) : null,
    buyOrders: asset.buy_orders ? asset.buy_orders.map(orderFromJSON) : null,

    isPresale: asset.is_presale,
    // Don't use previews if it's a special image
    imageUrl:
      isAnimated || isSvg
        ? asset.image_url
        : asset.image_preview_url || asset.image_url,
    imagePreviewUrl: asset.image_preview_url,
    imageUrlOriginal: asset.image_original_url,
    imageUrlThumbnail: asset.image_thumbnail_url,

    externalLink: asset.external_link,
    openseaLink: asset.permalink,
    traits: asset.traits,
    numSales: asset.num_sales,
    lastSale: asset.last_sale ? assetEventFromJSON(asset.last_sale) : null,
    backgroundColor: asset.background_color
      ? `#${asset.background_color}`
      : null,

    transferFee: asset.transfer_fee ? makeBigNumber(asset.transfer_fee) : null,
    transferFeePaymentToken: asset.transfer_fee_payment_token
      ? tokenFromJSON(asset.transfer_fee_payment_token)
      : null,
  };
  // If orders were included, put them in sell/buy order groups
  if (fromJSON.orders && !fromJSON.sellOrders) {
    fromJSON.sellOrders = fromJSON.orders.filter(
      (o) => o.side == OrderSide.Sell
    );
  }
  if (fromJSON.orders && !fromJSON.buyOrders) {
    fromJSON.buyOrders = fromJSON.orders.filter((o) => o.side == OrderSide.Buy);
  }
  return fromJSON;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const assetEventFromJSON = (assetEvent: any): AssetEvent => {
  return {
    eventType: assetEvent.event_type,
    eventTimestamp: assetEvent.event_timestamp,
    auctionType: assetEvent.auction_type,
    totalPrice: assetEvent.total_price,
    transaction: assetEvent.transaction
      ? transactionFromJSON(assetEvent.transaction)
      : null,
    paymentToken: assetEvent.payment_token
      ? tokenFromJSON(assetEvent.payment_token)
      : null,
  };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const transactionFromJSON = (transaction: any): Transaction => {
  return {
    fromAccount: accountFromJSON(transaction.from_account),
    toAccount: accountFromJSON(transaction.to_account),
    createdDate: new Date(`${transaction.created_date}Z`),
    modifiedDate: new Date(`${transaction.modified_date}Z`),
    transactionHash: transaction.transaction_hash,
    transactionIndex: transaction.transaction_index,
    blockNumber: transaction.block_number,
    blockHash: transaction.block_hash,
    timestamp: new Date(`${transaction.timestamp}Z`),
  };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const accountFromJSON = (account: any): OpenSeaAccount => {
  return {
    address: account.address,
    config: account.config,
    profileImgUrl: account.profile_img_url,
    user: account.user ? userFromJSON(account.user) : null,
  };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const userFromJSON = (user: any): OpenSeaUser => {
  return {
    username: user.username,
  };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const assetBundleFromJSON = (asset_bundle: any): OpenSeaAssetBundle => {
  return {
    maker: asset_bundle.maker,
    assets: asset_bundle.assets ? asset_bundle.assets.map(assetFromJSON) : [],
    assetContract: asset_bundle.asset_contract
      ? assetContractFromJSON(asset_bundle.asset_contract)
      : undefined,
    name: asset_bundle.name,
    slug: asset_bundle.slug,
    description: asset_bundle.description,
    externalLink: asset_bundle.external_link,
    permalink: asset_bundle.permalink,

    sellOrders: asset_bundle.sell_orders
      ? asset_bundle.sell_orders.map(orderFromJSON)
      : null,
  };
};

const assetContractFromJSON = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  asset_contract: any
): OpenSeaAssetContract => {
  return {
    name: asset_contract.name,
    description: asset_contract.description,
    type: asset_contract.asset_contract_type,
    schemaName: asset_contract.schema_name,
    address: asset_contract.address,
    tokenSymbol: asset_contract.symbol,
    buyerFeeBasisPoints: +asset_contract.buyer_fee_basis_points,
    sellerFeeBasisPoints: +asset_contract.seller_fee_basis_points,
    openseaBuyerFeeBasisPoints: +asset_contract.opensea_buyer_fee_basis_points,
    openseaSellerFeeBasisPoints:
      +asset_contract.opensea_seller_fee_basis_points,
    devBuyerFeeBasisPoints: +asset_contract.dev_buyer_fee_basis_points,
    devSellerFeeBasisPoints: +asset_contract.dev_seller_fee_basis_points,
    imageUrl: asset_contract.image_url,
    externalLink: asset_contract.external_link,
    wikiLink: asset_contract.wiki_link,
  };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const collectionFromJSON = (collection: any): OpenSeaCollection => {
  const createdDate = new Date(`${collection.created_date}Z`);

  return {
    createdDate,
    name: collection.name,
    description: collection.description,
    slug: collection.slug,
    editors: collection.editors,
    hidden: collection.hidden,
    featured: collection.featured,
    featuredImageUrl: collection.featured_image_url,
    displayData: collection.display_data,
    paymentTokens: (collection.payment_tokens || []).map(tokenFromJSON),
    openseaBuyerFeeBasisPoints: +collection.opensea_buyer_fee_basis_points,
    openseaSellerFeeBasisPoints: +collection.opensea_seller_fee_basis_points,
    devBuyerFeeBasisPoints: +collection.dev_buyer_fee_basis_points,
    devSellerFeeBasisPoints: +collection.dev_seller_fee_basis_points,
    payoutAddress: collection.payout_address,
    imageUrl: collection.image_url,
    largeImageUrl: collection.large_image_url,
    stats: collection.stats,
    traitStats: collection.traits as OpenSeaTraitStats,
    externalLink: collection.external_url,
    wikiLink: collection.wiki_url,
    fees: {
      openseaFees: new Map(Object.entries(collection.fees.opensea_fees || {})),
      sellerFees: new Map(Object.entries(collection.fees.seller_fees || {})),
    },
  };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const tokenFromJSON = (token: any): OpenSeaFungibleToken => {
  return {
    name: token.name,
    symbol: token.symbol,
    decimals: token.decimals,
    address: token.address,
    imageUrl: token.image_url,
    ethPrice: token.eth_price,
    usdPrice: token.usd_price,
  };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const orderFromJSON = (order: any): Order => {
  const createdDate = new Date(`${order.created_date}Z`);

  const fromJSON: Order = {
    hash: order.order_hash || order.hash,
    cancelledOrFinalized: order.cancelled || order.finalized,
    markedInvalid: order.marked_invalid,
    metadata: order.metadata,
    quantity: new BigNumber(order.quantity || 1),
    exchange: order.exchange,
    makerAccount: order.maker,
    takerAccount: order.taker,
    // Use string address to conform to Wyvern Order schema
    maker: order.maker.address,
    taker: order.taker.address,
    makerRelayerFee: new BigNumber(order.maker_relayer_fee),
    takerRelayerFee: new BigNumber(order.taker_relayer_fee),
    makerProtocolFee: new BigNumber(order.maker_protocol_fee),
    takerProtocolFee: new BigNumber(order.taker_protocol_fee),
    makerReferrerFee: new BigNumber(order.maker_referrer_fee || 0),
    waitingForBestCounterOrder: order.fee_recipient.address == NULL_ADDRESS,
    feeMethod: order.fee_method,
    feeRecipientAccount: order.fee_recipient,
    feeRecipient: order.fee_recipient.address,
    side: order.side,
    saleKind: order.sale_kind,
    target: order.target,
    howToCall: order.how_to_call,
    calldata: order.calldata,
    replacementPattern: order.replacement_pattern,
    staticTarget: order.static_target,
    staticExtradata: order.static_extradata,
    paymentToken: order.payment_token,
    basePrice: new BigNumber(order.base_price),
    extra: new BigNumber(order.extra),
    currentBounty: new BigNumber(order.current_bounty || 0),
    currentPrice: new BigNumber(order.current_price || 0),

    createdTime: new BigNumber(Math.round(createdDate.getTime() / 1000)),
    listingTime: new BigNumber(order.listing_time),
    expirationTime: new BigNumber(order.expiration_time),

    salt: new BigNumber(order.salt),
    v: parseInt(order.v),
    r: order.r,
    s: order.s,

    paymentTokenContract: order.payment_token_contract
      ? tokenFromJSON(order.payment_token_contract)
      : undefined,
    asset: order.asset ? assetFromJSON(order.asset) : undefined,
    assetBundle: order.asset_bundle
      ? assetBundleFromJSON(order.asset_bundle)
      : undefined,
  };

  // Use client-side price calc, to account for buyer fee (not added by server) and latency
  fromJSON.currentPrice = estimateCurrentPrice(fromJSON);

  return fromJSON;
};

/**
 * Convert an order to JSON, hashing it as well if necessary
 * @param order order (hashed or unhashed)
 */
export const orderToJSON = (order: Order): OrderJSON => {
  return {
    exchange: order.exchange.toLowerCase(),
    maker: order.maker.toLowerCase(),
    taker: order.taker.toLowerCase(),
    makerRelayerFee: order.makerRelayerFee.toString(),
    takerRelayerFee: order.takerRelayerFee.toString(),
    makerProtocolFee: order.makerProtocolFee.toString(),
    takerProtocolFee: order.takerProtocolFee.toString(),
    makerReferrerFee: order.makerReferrerFee.toString(),
    feeMethod: order.feeMethod,
    feeRecipient: order.feeRecipient.toLowerCase(),
    side: order.side,
    saleKind: order.saleKind,
    target: order.target.toLowerCase(),
    howToCall: order.howToCall,
    calldata: order.calldata,
    replacementPattern: order.replacementPattern,
    staticTarget: order.staticTarget.toLowerCase(),
    staticExtradata: order.staticExtradata,
    paymentToken: order.paymentToken.toLowerCase(),
    quantity: order.quantity.toString(),
    basePrice: order.basePrice.toString(),
    englishAuctionReservePrice: order.englishAuctionReservePrice
      ? order.englishAuctionReservePrice.toString()
      : undefined,
    extra: order.extra.toString(),
    createdTime: order.createdTime ? order.createdTime.toString() : undefined,
    listingTime: order.listingTime.toString(),
    expirationTime: order.expirationTime.toString(),
    salt: order.salt.toString(),

    metadata: order.metadata,

    v: order.v,
    r: order.r,
    s: order.s,

    nonce: order.nonce,
  };
};

export type BigNumberInput = number | string | BigNumber;

/**
 * Special fixes for making BigNumbers using web3 results
 * @param arg An arg or the result of a web3 call to turn into a BigNumber
 */
export function makeBigNumber(arg: BigNumberInput): BigNumber {
  // Zero sometimes returned as 0x from contracts
  if (arg === "0x") {
    arg = 0;
  }
  // fix "new BigNumber() number type has more than 15 significant digits"
  arg = arg.toString();
  return new BigNumber(arg);
}

/**
 * Estimates the price of an order
 * @param order The order to estimate price on
 * @param secondsToBacktrack The number of seconds to subtract on current time,
 *  to fix race conditions
 * @param shouldRoundUp Whether to round up fractional wei
 */
function estimateCurrentPrice(
  order: Order,
  secondsToBacktrack = 30,
  shouldRoundUp = true
) {
  let { basePrice, listingTime, expirationTime, extra } = order;
  const { side, takerRelayerFee, saleKind } = order;

  const now = new BigNumber(Math.round(Date.now() / 1000)).minus(
    secondsToBacktrack
  );
  basePrice = new BigNumber(basePrice);
  listingTime = new BigNumber(listingTime);
  expirationTime = new BigNumber(expirationTime);
  extra = new BigNumber(extra);

  let exactPrice = basePrice;

  if (saleKind === SaleKind.FixedPrice) {
    // Do nothing, price is correct
  } else if (saleKind === SaleKind.DutchAuction) {
    const diff = extra
      .times(now.minus(listingTime))
      .dividedBy(expirationTime.minus(listingTime));

    exactPrice =
      side == OrderSide.Sell
        ? /* Sell-side - start price: basePrice. End price: basePrice - extra. */
          basePrice.minus(diff)
        : /* Buy-side - start price: basePrice. End price: basePrice + extra. */
          basePrice.plus(diff);
  }

  // Add taker fee only for buyers
  if (side === OrderSide.Sell && !order.waitingForBestCounterOrder) {
    // Buyer fee increases sale price
    exactPrice = exactPrice.times(+takerRelayerFee / INVERSE_BASIS_POINT + 1);
  }

  return shouldRoundUp
    ? exactPrice.integerValue(BigNumber.ROUND_CEIL)
    : exactPrice;
}

/**
 * Delay using setTimeout
 * @param ms milliseconds to wait
 */
export async function delay(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * The longest time that an order is valid for is six months from the current date
 * @returns unix timestamp
 */
export const getMaxOrderExpirationTimestamp = () => {
  const maxExpirationDate = new Date();

  maxExpirationDate.setMonth(
    maxExpirationDate.getMonth() + MAX_EXPIRATION_MONTHS
  );
  maxExpirationDate.setDate(maxExpirationDate.getDate() - 1);

  return Math.round(maxExpirationDate.getTime() / 1000);
};

export const getAssetItemType = (schemaName?: SchemaName) => {
  switch (schemaName) {
    case "ERC20":
      return ItemType.ERC20;
    case "ERC721":
      return ItemType.ERC721;
    case "ERC1155":
      return ItemType.ERC1155;
    default:
      throw new Error(`Unknown schema name: ${schemaName}`);
  }
};

const SHARED_STOREFRONT_ADDRESSES = new Set([
  SHARED_STORE_FRONT_ADDRESS_MAINNET.toLowerCase(),
  SHARED_STORE_FRONT_ADDRESS_RINKEBY.toLowerCase(),
]);

/**
 * Checks if the token address is the shared storefront address and if so replaces
 * that address with the lazy mint adapter addres. Otherwise, returns the input token address
 * @param tokenAddress token address
 * @returns input token address or lazy mint adapter address
 */
export const getAddressAfterRemappingSharedStorefrontAddressToLazyMintAdapterAddress =
  (tokenAddress: string): string => {
    return SHARED_STOREFRONT_ADDRESSES.has(tokenAddress.toLowerCase())
      ? SHARED_STOREFRONT_LAZY_MINT_ADAPTER_ADDRESS
      : tokenAddress;
  };

/**
 * Sums up the basis points for an Opensea or seller fee map and returns the
 * single numeric value if the map is not empty. Otherwise, it returns 0
 * @param fees a `Fees` submap holding fees (either Fees.openseaFees
 *  or Fees.sellerFees)
 * @returns sum of basis points in a fee map
 */
export const feesToBasisPoints = (
  fees: Map<string, number> | undefined
): number => {
  if (!fees) {
    return 0;
  }

  return Array.from(fees.values()).reduce(
    (sum, basisPoints) => basisPoints + sum,
    0
  );
};
