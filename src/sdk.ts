import { Seaport } from "@opensea/seaport-js";
import { CROSS_CHAIN_SEAPORT_ADDRESS } from "@opensea/seaport-js/lib/constants";
import {
  ConsiderationInputItem,
  CreateInputItem,
  OrderComponents,
  Signer,
} from "@opensea/seaport-js/lib/types";
import { BigNumber } from "bignumber.js";
import { ethers, providers } from "ethers";
import { EventEmitter } from "fbemitter";
import { WyvernProtocol } from "wyvern-js";
import { OpenSeaAPI } from "./api";
import {
  CONDUIT_KEYS_TO_CONDUIT,
  DEFAULT_SELLER_FEE_BASIS_POINTS,
  INVERSE_BASIS_POINT,
  NULL_ADDRESS,
  NULL_BLOCK_HASH,
  CROSS_CHAIN_DEFAULT_CONDUIT_KEY,
  OPENSEA_FEE_RECIPIENT,
  DEFAULT_ZONE_BY_NETWORK,
  UNISWAP_FACTORY_ADDRESS_MAINNET,
  UNISWAP_FACTORY_ADDRESS_RINKEBY,
  WETH_ADDRESS_BY_NETWORK,
  WRAPPED_NFT_FACTORY_ADDRESS_MAINNET,
  WRAPPED_NFT_FACTORY_ADDRESS_RINKEBY,
  WRAPPED_NFT_LIQUIDATION_PROXY_ADDRESS_MAINNET,
  WRAPPED_NFT_LIQUIDATION_PROXY_ADDRESS_RINKEBY,
} from "./constants";
import {
  constructPrivateListingCounterOrder,
  getPrivateListingConsiderations,
  getPrivateListingFulfillments,
} from "./orders/privateListings";
import { OrderV2 } from "./orders/types";
import {
  Asset,
  EventData,
  EventType,
  Fees,
  Network,
  OpenSeaAPIConfig,
  OpenSeaAsset,
  OrderSide,
  WyvernSchemaName,
} from "./types";
import {
  confirmTransaction,
  delay,
  makeBigNumber,
  getMaxOrderExpirationTimestamp,
  getAssetItemType,
  BigNumberInput,
  getAddressAfterRemappingSharedStorefrontAddressToLazyMintAdapterAddress,
  feesToBasisPoints,
} from "./utils/utils";

export class OpenSeaSDK {
  // Ethers provider
  public ethersProvider: providers.Provider;
  // Seaport client
  public seaport: Seaport;
  // Logger function to use when debugging
  public logger: (arg: string) => void;
  // API instance on this seaport
  public readonly api: OpenSeaAPI;

  private _networkName: Network;
  private _emitter: EventEmitter;
  private _wrappedNFTFactoryAddress: string;
  private _wrappedNFTLiquidationProxyAddress: string;
  private _uniswapFactoryAddress: string;

  /**
   * Your very own seaport.
   * Create a new instance of OpenSeaJS.
   * @param signer Web3 Provider to use for transactions. For example:
   *  `const provider = new Web3.providers.HttpProvider('https://mainnet.infura.io')`
   * @param apiConfig configuration options, including `networkName`
   * @param logger logger, optional, a function that will be called with debugging
   *  information
   */
  constructor(
    signer: Signer,
    apiConfig: OpenSeaAPIConfig = {},
    logger?: (arg: string) => void
  ) {
    // API config
    apiConfig.networkName = apiConfig.networkName || Network.Main;
    this.api = new OpenSeaAPI(apiConfig);

    this._networkName = apiConfig.networkName;

    // Ethers Config
    this.ethersProvider = signer.provider as ethers.providers.Provider;
    this.seaport = new Seaport(signer, {
      conduitKeyToConduit: CONDUIT_KEYS_TO_CONDUIT,
      balanceAndApprovalChecksOnOrderCreation: false,
      overrides: {
        defaultConduitKey: CROSS_CHAIN_DEFAULT_CONDUIT_KEY,
      },
    });

    // WrappedNFTLiquidationProxy Config
    this._wrappedNFTFactoryAddress =
      this._networkName == Network.Main
        ? WRAPPED_NFT_FACTORY_ADDRESS_MAINNET
        : WRAPPED_NFT_FACTORY_ADDRESS_RINKEBY;
    this._wrappedNFTLiquidationProxyAddress =
      this._networkName == Network.Main
        ? WRAPPED_NFT_LIQUIDATION_PROXY_ADDRESS_MAINNET
        : WRAPPED_NFT_LIQUIDATION_PROXY_ADDRESS_RINKEBY;
    this._uniswapFactoryAddress =
      this._networkName == Network.Main
        ? UNISWAP_FACTORY_ADDRESS_MAINNET
        : UNISWAP_FACTORY_ADDRESS_RINKEBY;

    // Emit events
    this._emitter = new EventEmitter();

    // Debugging: default to nothing
    this.logger = logger || ((arg: string) => arg);
  }

  private getAmountWithBasisPointsApplied = (
    amount: BigNumber,
    basisPoints: number
  ) => {
    return amount
      .multipliedBy(basisPoints)
      .dividedBy(INVERSE_BASIS_POINT)
      .toString();
  };

  private async getFees({
    openseaAsset: asset,
    paymentTokenAddress,
    startAmount,
    endAmount,
  }: {
    openseaAsset: OpenSeaAsset;
    paymentTokenAddress: string;
    startAmount: BigNumber;
    endAmount?: BigNumber;
  }): Promise<{
    sellerFee: ConsiderationInputItem;
    openseaSellerFee: ConsiderationInputItem;
    collectionSellerFees: ConsiderationInputItem[];
  }> {
    // Seller fee basis points
    const openseaSellerFeeBasisPoints = DEFAULT_SELLER_FEE_BASIS_POINTS;
    const collectionSellerFeeBasisPoints = feesToBasisPoints(
      asset.collection.fees?.sellerFees
    );

    // Seller basis points
    const sellerBasisPoints =
      INVERSE_BASIS_POINT -
      openseaSellerFeeBasisPoints -
      collectionSellerFeeBasisPoints;

    const getConsiderationItem = (basisPoints: number, recipient?: string) => {
      return {
        token: paymentTokenAddress,
        amount: this.getAmountWithBasisPointsApplied(startAmount, basisPoints),
        endAmount: this.getAmountWithBasisPointsApplied(
          endAmount ?? startAmount,
          basisPoints
        ),
        recipient,
      };
    };

    const getConsiderationItemsFromSellerFees = (
      fees: Fees
    ): ConsiderationInputItem[] => {
      const sellerFees = fees.sellerFees;
      return Array.from(sellerFees.entries()).map(
        ([recipient, basisPoints]) => {
          return getConsiderationItem(basisPoints, recipient);
        }
      );
    };

    return {
      sellerFee: getConsiderationItem(sellerBasisPoints),
      openseaSellerFee: getConsiderationItem(
        openseaSellerFeeBasisPoints,
        OPENSEA_FEE_RECIPIENT
      ),
      collectionSellerFees:
        collectionSellerFeeBasisPoints > 0 && asset.collection.fees
          ? getConsiderationItemsFromSellerFees(asset.collection.fees)
          : [],
    };
  }

  private getAssetItems(
    assets: Asset[],
    quantities: BigNumber[] = [],
    fallbackSchema?: WyvernSchemaName
  ): CreateInputItem[] {
    return assets.map((asset, index) => ({
      itemType: getAssetItemType(this._getSchemaName(asset) ?? fallbackSchema),
      token:
        getAddressAfterRemappingSharedStorefrontAddressToLazyMintAdapterAddress(
          asset.tokenAddress
        ),
      identifier: asset.tokenId ?? undefined,
      amount: quantities[index].toString() ?? "1",
    }));
  }

  /**
   * Create a buy order to make an offer on an asset.
   * @param options Options for creating the buy order
   * @param options.asset The asset to trade
   * @param options.accountAddress Address of the maker's wallet
   * @param options.startAmount Value of the offer, in units of the payment token (or wrapped ETH if no payment token address specified)
   * @param options.quantity The number of assets to bid for (if fungible or semi-fungible). Defaults to 1. In units, not base units, e.g. not wei
   * @param options.domain An optional domain to be hashed and included in the first four bytes of the random salt.
   * @param options.salt Arbitrary salt. If not passed in, a random salt will be generated with the first four bytes being the domain hash or empty.
   * @param options.expirationTime Expiration time for the order, in seconds
   * @param options.paymentTokenAddress Optional address for using an ERC-20 token in the order. If unspecified, defaults to WETH
   */
  public async createBuyOrder({
    asset,
    accountAddress,
    startAmount,
    quantity = 1,
    domain = "",
    salt = "",
    expirationTime,
    paymentTokenAddress,
  }: {
    asset: Asset;
    accountAddress: string;
    startAmount: BigNumberInput;
    quantity?: BigNumberInput;
    domain?: string;
    salt?: string;
    expirationTime?: BigNumberInput;
    paymentTokenAddress?: string;
  }): Promise<OrderV2> {
    if (!asset.tokenId) {
      throw new Error("Asset must have a tokenId");
    }
    paymentTokenAddress =
      paymentTokenAddress ?? WETH_ADDRESS_BY_NETWORK[this._networkName];

    const openseaAsset = await this.api.getAsset(asset);
    const considerationAssetItems = this.getAssetItems(
      [openseaAsset],
      [makeBigNumber(quantity)]
    );

    const { basePrice } = await this._getPriceParameters(
      OrderSide.Buy,
      paymentTokenAddress,
      makeBigNumber(expirationTime ?? getMaxOrderExpirationTimestamp()),
      makeBigNumber(startAmount)
    );

    const { openseaSellerFee, collectionSellerFees: collectionSellerFees } =
      await this.getFees({
        openseaAsset,
        paymentTokenAddress,
        startAmount: basePrice,
      });
    const considerationFeeItems = [openseaSellerFee, ...collectionSellerFees];

    const { executeAllActions } = await this.seaport.createOrder(
      {
        offer: [
          {
            token: paymentTokenAddress,
            amount: basePrice.toString(),
          },
        ],
        consideration: [...considerationAssetItems, ...considerationFeeItems],
        endTime:
          expirationTime?.toString() ??
          getMaxOrderExpirationTimestamp().toString(),
        zone: DEFAULT_ZONE_BY_NETWORK[this._networkName],
        domain,
        salt,
        restrictedByZone: true,
        allowPartialFills: true,
      },
      accountAddress
    );
    const order = await executeAllActions();

    return this.api.postOrder(order, { protocol: "seaport", side: "bid" });
  }

  /**
   * Create a sell order to auction an asset.
   * @param options Options for creating the sell order
   * @param options.asset The asset to trade
   * @param options.accountAddress Address of the maker's wallet
   * @param options.startAmount Price of the asset at the start of the auction. Units are in the amount of a token above the token's decimal places (integer part). For example, for ether, expected units are in ETH, not wei.
   * @param options.endAmount Optional price of the asset at the end of its expiration time. Units are in the amount of a token above the token's decimal places (integer part). For example, for ether, expected units are in ETH, not wei.
   * @param options.quantity The number of assets to sell (if fungible or semi-fungible). Defaults to 1. In units, not base units, e.g. not wei.
   * @param options.domain An optional domain to be hashed and included in the first four bytes of the random salt.
   * @param options.salt Arbitrary salt. If not passed in, a random salt will be generated with the first four bytes being the domain hash or empty.
   * @param options.listingTime Optional time when the order will become fulfillable, in UTC seconds. Undefined means it will start now.
   * @param options.expirationTime Expiration time for the order, in UTC seconds.
   * @param options.paymentTokenAddress Address of the ERC-20 token to accept in return. If undefined or null, uses Ether.
   * @param options.buyerAddress Optional address that's allowed to purchase this item. If specified, no other address will be able to take the order, unless its value is the null address.
   */
  public async createSellOrder({
    asset,
    accountAddress,
    startAmount,
    endAmount,
    quantity = 1,
    domain = "",
    salt = "",
    listingTime,
    expirationTime,
    paymentTokenAddress = NULL_ADDRESS,
    buyerAddress,
  }: {
    asset: Asset;
    accountAddress: string;
    startAmount: BigNumberInput;
    endAmount?: BigNumberInput;
    quantity?: BigNumberInput;
    domain?: string;
    salt?: string;
    listingTime?: string;
    expirationTime?: BigNumberInput;
    paymentTokenAddress?: string;
    buyerAddress?: string;
  }): Promise<OrderV2> {
    if (!asset.tokenId) {
      throw new Error("Asset must have a tokenId");
    }

    const openseaAsset = await this.api.getAsset(asset);
    const offerAssetItems = this.getAssetItems(
      [openseaAsset],
      [makeBigNumber(quantity)]
    );

    const { basePrice, endPrice } = await this._getPriceParameters(
      OrderSide.Sell,
      paymentTokenAddress,
      makeBigNumber(expirationTime ?? getMaxOrderExpirationTimestamp()),
      makeBigNumber(startAmount),
      endAmount !== undefined ? makeBigNumber(endAmount) : undefined
    );

    const {
      sellerFee,
      openseaSellerFee,
      collectionSellerFees: collectionSellerFees,
    } = await this.getFees({
      openseaAsset,
      paymentTokenAddress,
      startAmount: basePrice,
      endAmount: endPrice,
    });
    const considerationFeeItems = [
      sellerFee,
      openseaSellerFee,
      collectionSellerFees,
    ].filter((item): item is ConsiderationInputItem => item !== undefined);

    if (buyerAddress) {
      considerationFeeItems.push(
        ...getPrivateListingConsiderations(offerAssetItems, buyerAddress)
      );
    }

    const { executeAllActions } = await this.seaport.createOrder(
      {
        offer: offerAssetItems,
        consideration: considerationFeeItems,
        startTime: listingTime,
        endTime:
          expirationTime?.toString() ??
          getMaxOrderExpirationTimestamp().toString(),
        zone: DEFAULT_ZONE_BY_NETWORK[this._networkName],
        domain,
        salt,
        restrictedByZone: true,
        allowPartialFills: true,
      },
      accountAddress
    );
    const order = await executeAllActions();

    return this.api.postOrder(order, { protocol: "seaport", side: "ask" });
  }

  private async fulfillPrivateOrder({
    order,
    accountAddress,
  }: {
    order: OrderV2;
    accountAddress: string;
  }): Promise<string> {
    let transactionHash: string;
    switch (order.protocolAddress) {
      case CROSS_CHAIN_SEAPORT_ADDRESS: {
        if (!order.taker?.address) {
          throw new Error(
            "Order is not a private listing must have a taker address"
          );
        }
        const counterOrder = constructPrivateListingCounterOrder(
          order.protocolData,
          order.taker.address
        );
        const fulfillments = getPrivateListingFulfillments(order.protocolData);
        const transaction = await this.seaport
          .matchOrders({
            orders: [order.protocolData, counterOrder],
            fulfillments,
            overrides: {
              value: counterOrder.parameters.offer[0].startAmount,
            },
            accountAddress,
          })
          .transact();
        const transactionReceipt = await transaction.wait();
        transactionHash = transactionReceipt.transactionHash;
        break;
      }
      default:
        throw new Error("Unsupported protocol");
    }

    await this._confirmTransaction(
      transactionHash,
      EventType.MatchOrders,
      "Fulfilling order"
    );
    return transactionHash;
  }

  /**
   * Fullfill or "take" an order for an asset, either a buy or sell order
   * @param options fullfillment options
   * @param options.order The order to fulfill, a.k.a. "take"
   * @param options.accountAddress The taker's wallet address
   * @param options.recipientAddress The optional address to receive the order's item(s) or curriencies. If not specified, defaults to accountAddress
   * @returns Transaction hash for fulfilling the order
   */
  public async fulfillOrder({
    order,
    accountAddress,
    recipientAddress,
  }: {
    order: OrderV2;
    accountAddress: string;
    recipientAddress?: string;
  }): Promise<string> {
    const isPrivateListing = !!order.taker;
    if (isPrivateListing) {
      if (recipientAddress) {
        throw new Error(
          "Private listings cannot be fulfilled with a recipient address"
        );
      }
      return this.fulfillPrivateOrder({
        order,
        accountAddress,
      });
    }

    let transactionHash: string;
    switch (order.protocolAddress) {
      case CROSS_CHAIN_SEAPORT_ADDRESS: {
        const { executeAllActions } = await this.seaport.fulfillOrder({
          order: order.protocolData,
          accountAddress,
          recipientAddress,
        });
        const transaction = await executeAllActions();
        transactionHash = transaction.hash;
        break;
      }
      default:
        throw new Error("Unsupported protocol");
    }

    await this._confirmTransaction(
      transactionHash,
      EventType.MatchOrders,
      "Fulfilling order"
    );
    return transactionHash;
  }

  private async cancelSeaportOrders({
    orders,
    accountAddress,
  }: {
    orders: OrderComponents[];
    accountAddress: string;
  }): Promise<string> {
    const transaction = await this.seaport
      .cancelOrders(orders, accountAddress)
      .transact();
    return transaction.hash;
  }

  /**
   * Cancel an order on-chain, preventing it from ever being fulfilled.
   * @param param0 __namedParameters Object
   * @param order The order to cancel
   * @param accountAddress The order maker's wallet address
   */
  public async cancelOrder({
    order,
    accountAddress,
  }: {
    order: OrderV2;
    accountAddress: string;
  }) {
    this._dispatch(EventType.CancelOrder, { orderV2: order, accountAddress });

    // Transact and get the transaction hash
    let transactionHash: string;
    switch (order.protocolAddress) {
      case CROSS_CHAIN_SEAPORT_ADDRESS: {
        transactionHash = await this.cancelSeaportOrders({
          orders: [order.protocolData.parameters],
          accountAddress,
        });
        break;
      }
      default:
        throw new Error("Unsupported protocol");
    }

    // Await transaction confirmation
    await this._confirmTransaction(
      transactionHash,
      EventType.CancelOrder,
      "Cancelling order"
    );
  }

  /**
   * Compute the `basePrice` and `extra` parameters to be used to price an order.
   * Also validates the expiration time and auction type.
   * @param tokenAddress Address of the ERC-20 token to use for trading.
   * Use the null address for ETH
   * @param expirationTime When the auction expires, or 0 if never.
   * @param startAmount The base value for the order, in the token's main units (e.g. ETH instead of wei)
   * @param endAmount The end value for the order, in the token's main units (e.g. ETH instead of wei). If unspecified, the order's `extra` attribute will be 0
   */
  private async _getPriceParameters(
    orderSide: OrderSide,
    tokenAddress: string,
    expirationTime: BigNumber,
    startAmount: BigNumber,
    endAmount?: BigNumber,
    waitingForBestCounterOrder = false,
    englishAuctionReservePrice?: BigNumber
  ) {
    const priceDiff =
      endAmount != null ? startAmount.minus(endAmount) : new BigNumber(0);
    const paymentToken = tokenAddress.toLowerCase();
    const isEther = tokenAddress == NULL_ADDRESS;
    const { tokens } = await this.api.getPaymentTokens({
      address: paymentToken,
    });
    const token = tokens[0];

    // Validation
    if (startAmount.isNaN() || startAmount == null || startAmount.lt(0)) {
      throw new Error(`Starting price must be a number >= 0`);
    }
    if (!isEther && !token) {
      throw new Error(`No ERC-20 token found for '${paymentToken}'`);
    }
    if (isEther && waitingForBestCounterOrder) {
      throw new Error(
        `English auctions must use wrapped ETH or an ERC-20 token.`
      );
    }
    if (isEther && orderSide === OrderSide.Buy) {
      throw new Error(`Offers must use wrapped ETH or an ERC-20 token.`);
    }
    if (priceDiff.lt(0)) {
      throw new Error(
        "End price must be less than or equal to the start price."
      );
    }
    if (priceDiff.gt(0) && expirationTime.eq(0)) {
      throw new Error(
        "Expiration time must be set if order will change in price."
      );
    }
    if (
      englishAuctionReservePrice &&
      !englishAuctionReservePrice.isZero() &&
      !waitingForBestCounterOrder
    ) {
      throw new Error("Reserve prices may only be set on English auctions.");
    }
    if (
      englishAuctionReservePrice &&
      !englishAuctionReservePrice.isZero() &&
      englishAuctionReservePrice < startAmount
    ) {
      throw new Error(
        "Reserve price must be greater than or equal to the start amount."
      );
    }

    // Note: WyvernProtocol.toBaseUnitAmount(makeBigNumber(startAmount), token.decimals)
    // will fail if too many decimal places, so special-case ether
    const basePrice = isEther
      ? makeBigNumber(
          ethers.utils.parseEther(startAmount.toString()).toString()
        ).integerValue()
      : WyvernProtocol.toBaseUnitAmount(startAmount, token.decimals);

    const endPrice = endAmount
      ? isEther
        ? makeBigNumber(
            ethers.utils.parseEther(endAmount.toString()).toString()
          ).integerValue()
        : WyvernProtocol.toBaseUnitAmount(endAmount, token.decimals)
      : undefined;

    const extra = isEther
      ? makeBigNumber(
          ethers.utils.parseEther(priceDiff.toString()).toString()
        ).integerValue()
      : WyvernProtocol.toBaseUnitAmount(priceDiff, token.decimals);

    const reservePrice = englishAuctionReservePrice
      ? isEther
        ? makeBigNumber(
            ethers.utils
              .parseEther(englishAuctionReservePrice.toString())
              .toString()
          ).integerValue()
        : WyvernProtocol.toBaseUnitAmount(
            englishAuctionReservePrice,
            token.decimals
          )
      : undefined;

    return { basePrice, extra, paymentToken, reservePrice, endPrice };
  }

  private _getSchemaName(asset: Asset | OpenSeaAsset) {
    if (asset.schemaName) {
      return asset.schemaName;
    } else if ("assetContract" in asset) {
      return asset.assetContract.schemaName;
    }

    return undefined;
  }

  private _dispatch(event: EventType, data: EventData) {
    this._emitter.emit(event, data);
  }

  private async _confirmTransaction(
    transactionHash: string,
    event: EventType,
    description: string,
    testForSuccess?: () => Promise<boolean>
  ): Promise<void> {
    const transactionEventData = { transactionHash, event };
    this.logger(`Transaction started: ${description}`);

    if (transactionHash == NULL_BLOCK_HASH) {
      // This was a smart contract wallet that doesn't know the transaction
      this._dispatch(EventType.TransactionCreated, { event });

      if (!testForSuccess) {
        // Wait if test not implemented
        this.logger(`Unknown action, waiting 1 minute: ${description}`);
        await delay(60 * 1000);
        return;
      }

      return await this._pollCallbackForConfirmation(
        event,
        description,
        testForSuccess
      );
    }

    // Normal wallet
    try {
      this._dispatch(EventType.TransactionCreated, transactionEventData);
      await confirmTransaction(this.ethersProvider, transactionHash);
      this.logger(`Transaction succeeded: ${description}`);
      this._dispatch(EventType.TransactionConfirmed, transactionEventData);
    } catch (error) {
      this.logger(`Transaction failed: ${description}`);
      this._dispatch(EventType.TransactionFailed, {
        ...transactionEventData,
        error,
      });
      throw error;
    }
  }

  private async _pollCallbackForConfirmation(
    event: EventType,
    description: string,
    testForSuccess: () => Promise<boolean>
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const initialRetries = 60;

      const testResolve: (r: number) => Promise<void> = async (retries) => {
        const wasSuccessful = await testForSuccess();
        if (wasSuccessful) {
          this.logger(`Transaction succeeded: ${description}`);
          this._dispatch(EventType.TransactionConfirmed, { event });
          return resolve();
        } else if (retries <= 0) {
          return reject();
        }

        if (retries % 10 == 0) {
          this.logger(
            `Tested transaction ${
              initialRetries - retries + 1
            } times: ${description}`
          );
        }
        await delay(5000);
        return testResolve(retries - 1);
      };

      return testResolve(initialRetries);
    });
  }
}
