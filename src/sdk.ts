import { Seaport } from "@opensea/seaport-js";
import { CROSS_CHAIN_SEAPORT_ADDRESS } from "@opensea/seaport-js/lib/constants";
import {
  ConsiderationInputItem,
  CreateInputItem,
  OrderComponents,
} from "@opensea/seaport-js/lib/types";
import { BigNumber } from "bignumber.js";
import { providers } from "ethers";
import { EventEmitter } from "fbemitter";
import Web3 from "web3";
import { WyvernProtocol } from "wyvern-js";
import * as WyvernSchemas from "wyvern-schemas";
import { Schema } from "wyvern-schemas/dist/types";
import { OpenSeaAPI } from "./api";
import {
  CK_ADDRESS,
  CK_RINKEBY_ADDRESS,
  CONDUIT_KEYS_TO_CONDUIT,
  DEFAULT_BUYER_FEE_BASIS_POINTS,
  DEFAULT_SELLER_FEE_BASIS_POINTS,
  INVERSE_BASIS_POINT,
  NULL_ADDRESS,
  NULL_BLOCK_HASH,
  CROSS_CHAIN_DEFAULT_CONDUIT_KEY,
  OPENSEA_FEE_RECIPIENT,
  DEFAULT_ZONE_BY_NETWORK,
  RPC_URL_PATH,
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
  TokenStandardVersion,
  WyvernAsset,
  WyvernFTAsset,
  WyvernNFTAsset,
  WyvernSchemaName,
} from "./types";
import { encodeTransferCall } from "./utils/schema";
import {
  annotateERC20TransferABI,
  annotateERC721TransferABI,
  confirmTransaction,
  delay,
  getWyvernAsset,
  makeBigNumber,
  sendRawTransaction,
  getMaxOrderExpirationTimestamp,
  getAssetItemType,
  BigNumberInput,
  getAddressAfterRemappingSharedStorefrontAddressToLazyMintAdapterAddress,
  feesToBasisPoints,
} from "./utils/utils";

export class OpenSeaSDK {
  // Web3 instance to use
  public web3: Web3;
  public web3ReadOnly: Web3;
  // Ethers provider
  public ethersProvider: providers.Web3Provider;
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
   * @param provider Web3 Provider to use for transactions. For example:
   *  `const provider = new Web3.providers.HttpProvider('https://mainnet.infura.io')`
   * @param apiConfig configuration options, including `networkName`
   * @param logger logger, optional, a function that will be called with debugging
   *  information
   */
  constructor(
    provider: Web3["currentProvider"],
    apiConfig: OpenSeaAPIConfig = {},
    logger?: (arg: string) => void
  ) {
    // API config
    apiConfig.networkName = apiConfig.networkName || Network.Main;
    this.api = new OpenSeaAPI(apiConfig);

    this._networkName = apiConfig.networkName;

    const readonlyProvider = new Web3.providers.HttpProvider(
      `${this.api.apiBaseUrl}/${RPC_URL_PATH}`
    );

    const useReadOnlyProvider = apiConfig.useReadOnlyProvider ?? true;

    // Web3 Config
    this.web3 = new Web3(provider);
    this.web3ReadOnly = useReadOnlyProvider
      ? new Web3(readonlyProvider)
      : this.web3;

    // Ethers Config
    this.ethersProvider = new providers.Web3Provider(
      provider as providers.ExternalProvider
    );
    this.seaport = new Seaport(this.ethersProvider, {
      conduitKeyToConduit: CONDUIT_KEYS_TO_CONDUIT,
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
    collectionSellerFees?: ConsiderationInputItem[];
    openseaBuyerFee?: ConsiderationInputItem;
    collectionBuyerFee?: ConsiderationInputItem;
  }> {
    // Seller fee basis points
    const openseaSellerFeeBasisPoints = DEFAULT_SELLER_FEE_BASIS_POINTS;
    const collectionSellerFeeBasisPoints = feesToBasisPoints(
      asset.collection.fees?.sellerFees
    );

    // Buyer fee basis points
    const openseaBuyerFeeBasisPoints = DEFAULT_BUYER_FEE_BASIS_POINTS;
    const collectionBuyerFeeBasisPoints =
      asset.collection.devBuyerFeeBasisPoints;

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
          : undefined,
      openseaBuyerFee:
        openseaBuyerFeeBasisPoints > 0
          ? getConsiderationItem(
              openseaBuyerFeeBasisPoints,
              OPENSEA_FEE_RECIPIENT
            )
          : undefined,
      collectionBuyerFee:
        collectionBuyerFeeBasisPoints > 0 && asset.collection.payoutAddress
          ? getConsiderationItem(
              collectionBuyerFeeBasisPoints,
              asset.collection.payoutAddress
            )
          : undefined,
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
   * @param options.expirationTime Expiration time for the order, in seconds
   * @param options.paymentTokenAddress Optional address for using an ERC-20 token in the order. If unspecified, defaults to WETH
   */
  public async createBuyOrder({
    asset,
    accountAddress,
    startAmount,
    quantity = 1,
    expirationTime,
    paymentTokenAddress,
  }: {
    asset: Asset;
    accountAddress: string;
    startAmount: BigNumberInput;
    quantity?: BigNumberInput;
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
    const considerationFeeItems = [
      openseaSellerFee,
      collectionSellerFees,
    ].filter((item): item is ConsiderationInputItem => item !== undefined);

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
   * Transfer a fungible or non-fungible asset to another address
   * @param param0 __namedParamaters Object
   * @param fromAddress The owner's wallet address
   * @param toAddress The recipient's wallet address
   * @param asset The fungible or non-fungible asset to transfer
   * @param quantity The amount of the asset to transfer, if it's fungible (optional). In units (not base units), e.g. not wei.
   * @returns Transaction hash
   */
  public async transfer({
    fromAddress,
    toAddress,
    asset,
    quantity = 1,
  }: {
    fromAddress: string;
    toAddress: string;
    asset: Asset;
    quantity?: number | BigNumber;
  }): Promise<string> {
    const schema = this._getSchema(this._getSchemaName(asset));
    const quantityBN = WyvernProtocol.toBaseUnitAmount(
      makeBigNumber(quantity),
      asset.decimals || 0
    );
    const wyAsset = getWyvernAsset(schema, asset, quantityBN);
    const isCryptoKitties = [CK_ADDRESS, CK_RINKEBY_ADDRESS].includes(
      wyAsset.address
    );
    // Since CK is common, infer isOldNFT from it in case user
    // didn't pass in `version`
    const isOldNFT =
      isCryptoKitties ||
      (!!asset.version &&
        [TokenStandardVersion.ERC721v1, TokenStandardVersion.ERC721v2].includes(
          asset.version
        ));

    const abi =
      this._getSchemaName(asset) === WyvernSchemaName.ERC20
        ? annotateERC20TransferABI(wyAsset as WyvernFTAsset)
        : isOldNFT
        ? annotateERC721TransferABI(wyAsset as WyvernNFTAsset)
        : schema.functions.transfer(wyAsset);

    this._dispatch(EventType.TransferOne, {
      accountAddress: fromAddress,
      toAddress,
      asset: wyAsset,
    });

    const data = encodeTransferCall(abi, fromAddress, toAddress);
    const txHash = await sendRawTransaction(
      this.web3,
      {
        from: fromAddress,
        to: abi.target,
        data,
      },
      (error) => {
        this._dispatch(EventType.TransactionDenied, {
          error,
          accountAddress: fromAddress,
        });
      }
    );

    await this._confirmTransaction(
      txHash,
      EventType.TransferOne,
      `Transferring asset`
    );
    return txHash;
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
          this.web3.utils.toWei(startAmount.toString(), "ether")
        ).integerValue()
      : WyvernProtocol.toBaseUnitAmount(startAmount, token.decimals);

    const endPrice = endAmount
      ? isEther
        ? makeBigNumber(
            this.web3.utils.toWei(endAmount.toString(), "ether")
          ).integerValue()
        : WyvernProtocol.toBaseUnitAmount(endAmount, token.decimals)
      : undefined;

    const extra = isEther
      ? makeBigNumber(
          this.web3.utils.toWei(priceDiff.toString(), "ether")
        ).integerValue()
      : WyvernProtocol.toBaseUnitAmount(priceDiff, token.decimals);

    const reservePrice = englishAuctionReservePrice
      ? isEther
        ? makeBigNumber(
            this.web3.utils.toWei(
              englishAuctionReservePrice.toString(),
              "ether"
            )
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

  private _getSchema(schemaName?: WyvernSchemaName): Schema<WyvernAsset> {
    const schemaName_ = schemaName || WyvernSchemaName.ERC721;
    const schema = WyvernSchemas.schemas[this._networkName].filter(
      (s) => s.name == schemaName_
    )[0];

    if (!schema) {
      throw new Error(
        `Trading for this asset (${schemaName_}) is not yet supported. Please contact us or check back later!`
      );
    }
    return schema;
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
      await confirmTransaction(this.web3, transactionHash);
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
