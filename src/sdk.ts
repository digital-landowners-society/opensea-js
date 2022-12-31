import { Seaport } from "@opensea/seaport-js";
import { CROSS_CHAIN_SEAPORT_ADDRESS } from "@opensea/seaport-js/lib/constants";
import {
  ConsiderationInputItem,
  CreateInputItem,
  OrderComponents,
  OrderWithCounter,
  Signer,
} from "@opensea/seaport-js/lib/types";
import { BigNumber } from "bignumber.js";
import { ethers, providers } from "ethers";
import { OpenSeaAPI } from "./api";
import {
  CONDUIT_KEYS_TO_CONDUIT,
  DEFAULT_SELLER_FEE_BASIS_POINTS,
  INVERSE_BASIS_POINT,
  NULL_ADDRESS,
  NULL_BLOCK_HASH,
  CROSS_CHAIN_DEFAULT_CONDUIT_KEY,
  OPENSEA_FEE_RECIPIENT,
  DEFAULT_ZONE_BY_CHAIN,
  WETH_ADDRESS_BY_CHAIN,
} from "./constants";
import { OrderV2 } from "./orders/types";
import {
  Asset,
  Chain,
  ContractData,
  Fees,
  Network,
  OpenSeaAPIConfig,
  OpenSeaAsset,
  OpenSeaFungibleToken,
  OrderSide,
  SchemaName,
  TokenData,
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
  assetFromJSON,
  tokenFromJSON,
} from "./utils";

export class OpenSeaSDK {
  // Ethers provider
  public ethersProvider: providers.Provider;
  // Seaport client
  public seaport: Seaport;
  // Logger function to use when debugging
  public logger: (arg: string) => void;
  // API instance on this seaport
  public readonly api: OpenSeaAPI;

  private readonly chain: Chain;

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
    this.chain = apiConfig.chain || Chain.Ethereum;

    // Ethers Config
    this.ethersProvider = signer.provider as ethers.providers.Provider;
    this.seaport = new Seaport(signer, {
      conduitKeyToConduit: CONDUIT_KEYS_TO_CONDUIT,
      balanceAndApprovalChecksOnOrderCreation: false,
      overrides: {
        defaultConduitKey: CROSS_CHAIN_DEFAULT_CONDUIT_KEY,
      },
    });

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
    fallbackSchema?: SchemaName
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

  private createOpenseaAsset(
    asset: Asset,
    assetContractData?: ContractData
  ): OpenSeaAsset {
    const assetData = {
      token_id: asset.tokenId,
      asset_contract: {
        address: asset.tokenAddress,
        schema_name: assetContractData?.schemaName || "ERC721",
      },
      collection: {
        fees: {
          seller_fees: {},
          opensea_fees: { [OPENSEA_FEE_RECIPIENT]: 250 },
        },
      },
    };
    if (assetContractData && assetContractData.sellerFeeAddress) {
      const sellerFeeAddress = assetContractData.sellerFeeAddress;
      const sellerFee = assetContractData.sellerFees || 500;
      assetData.collection.fees.seller_fees = { [sellerFeeAddress]: sellerFee };
    }
    return assetFromJSON(assetData);
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
   * @param options.paymentTokenData Optional address for using an ERC-20 token in the order. If unspecified, defaults to WETH
   */
  public async createBuyOrder({
    asset,
    accountAddress,
    startAmount,
    quantity = 1,
    domain = "",
    salt = "",
    expirationTime,
    paymentTokenData,
    assetContractData,
  }: {
    asset: Asset;
    accountAddress: string;
    startAmount: BigNumberInput;
    quantity?: BigNumberInput;
    domain?: string;
    salt?: string;
    expirationTime?: BigNumberInput;
    paymentTokenData?: TokenData;
    assetContractData?: ContractData;
  }): Promise<OrderV2> {
    const order = await this.generateBuyOrder({
      asset,
      accountAddress,
      startAmount,
      quantity,
      domain,
      salt,
      expirationTime,
      paymentTokenData,
      assetContractData,
    });

    return this.api.postOrder(order, {
      protocol: "seaport",
      side: "bid",
      chain: this.chain,
    });
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
   * @param options.paymentTokenData Optional address for using an ERC-20 token in the order. If unspecified, defaults to WETH
   */
  public async generateBuyOrder({
    asset,
    accountAddress,
    startAmount,
    quantity = 1,
    domain = "",
    salt = "",
    expirationTime,
    paymentTokenData,
    assetContractData,
  }: {
    asset: Asset;
    accountAddress: string;
    startAmount: BigNumberInput;
    quantity?: BigNumberInput;
    domain?: string;
    salt?: string;
    expirationTime?: BigNumberInput;
    paymentTokenData?: TokenData;
    assetContractData?: ContractData;
  }): Promise<OrderWithCounter> {
    if (!asset.tokenId) {
      throw new Error("Asset must have a tokenId");
    }
    const paymentTokenAddress = paymentTokenData
      ? paymentTokenData.address
      : WETH_ADDRESS_BY_CHAIN[this.chain];

    const openseaAsset = this.createOpenseaAsset(asset, assetContractData);

    const considerationAssetItems = this.getAssetItems(
      [openseaAsset],
      [makeBigNumber(quantity)]
    );

    const { basePrice } = await this._getPriceParameters(
      OrderSide.Buy,
      makeBigNumber(expirationTime ?? getMaxOrderExpirationTimestamp()),
      makeBigNumber(startAmount),
      makeBigNumber(startAmount),
      paymentTokenData
    );

    // TODO check why we need async here
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
        counter: 0, // TODO we provide 0 in every case but we need to check what is the meaning of this field
        consideration: [...considerationAssetItems, ...considerationFeeItems],
        endTime:
          expirationTime?.toString() ??
          getMaxOrderExpirationTimestamp().toString(),
        zone: DEFAULT_ZONE_BY_CHAIN[this.chain],
        domain,
        salt,
        restrictedByZone: true,
        allowPartialFills: true,
      },
      accountAddress
    );

    return await executeAllActions();
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
  public async generateSellOrder({
    asset,
    accountAddress,
    startAmount,
    endAmount,
    quantity = 1,
    domain = "",
    salt = "",
    listingTime,
    expirationTime,
    buyerAddress,
    paymentTokenData,
    assetContractData,
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
    buyerAddress?: string;
    paymentTokenData?: TokenData;
    assetContractData?: ContractData;
  }): Promise<OrderWithCounter> {
    if (!asset.tokenId) {
      throw new Error("Asset must have a tokenId");
    }
    const openseaAsset = this.createOpenseaAsset(asset, assetContractData);

    const offerAssetItems = this.getAssetItems(
      [openseaAsset],
      [makeBigNumber(quantity)]
    );

    const {
      basePrice,
      endPrice,
      address: paymentTokenAddress,
    } = await this._getPriceParameters(
      OrderSide.Sell,
      makeBigNumber(expirationTime ?? getMaxOrderExpirationTimestamp()),
      makeBigNumber(startAmount),
      endAmount !== undefined ? makeBigNumber(endAmount) : undefined,
      paymentTokenData
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
      ...collectionSellerFees,
    ];

    if (buyerAddress) {
      throw new Error("Buyer address is not supported yet");
    }

    const { executeAllActions } = await this.seaport.createOrder(
      {
        offer: offerAssetItems,
        consideration: considerationFeeItems,
        startTime: listingTime,
        endTime:
          expirationTime?.toString() ??
          getMaxOrderExpirationTimestamp().toString(),
        zone: DEFAULT_ZONE_BY_CHAIN[this.chain],
        domain,
        salt,
        restrictedByZone: true,
        allowPartialFills: true,
      },
      accountAddress
    );
    return await executeAllActions();
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
    buyerAddress,
    paymentTokenData,
    assetContractData,
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
    buyerAddress?: string;
    paymentTokenData?: TokenData;
    assetContractData?: ContractData;
  }): Promise<OrderV2> {
    const order = await this.generateSellOrder({
      asset,
      accountAddress,
      startAmount,
      endAmount,
      quantity,
      domain,
      salt,
      listingTime,
      expirationTime,
      paymentTokenData,
      buyerAddress,
      assetContractData,
    });

    return this.api.postOrder(order, {
      protocol: "seaport",
      side: "ask",
      chain: this.chain,
    });
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
      throw new Error("Private listings cannot be fulfilled");
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

    await this._confirmTransaction(transactionHash, "Fulfilling order");
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
    await this._confirmTransaction(transactionHash, "Cancelling order");
  }

  /**
   *A baseUnit is defined as the smallest denomination of a token. An amount expressed in baseUnits is the amount expressed in the smallest denomination. E.g: 1 unit of a token with 18 decimal places is expressed in baseUnits as 1000000000000000000
   *Params:
   *    amount – The amount of units that you would like converted to baseUnits.
   *decimals – The number of decimal places the unit amount has.
   *Returns:
   *    The amount in baseUnits.
   */
  public static toBaseUnitAmount(
    amount: BigNumber,
    decimals: number
  ): BigNumber {
    // assert.isBigNumber("amount", amount);
    // assert.isNumber("decimals", decimals);
    const unit = new BigNumber(10).pow(decimals);
    const baseUnitAmount = amount.times(unit);
    const hasDecimals = baseUnitAmount.decimalPlaces() !== 0;
    if (hasDecimals) {
      throw new Error(
        `Invalid unit amount: ${amount.toString()} - Too many decimal places`
      );
    }
    return baseUnitAmount;
  }

  /**
   * Compute the `basePrice` and `extra` parameters to be used to price an order.
   * Also validates the expiration time and auction type.
   * @param tokenData Address of the ERC-20 token to use for trading.
   * Use the null address for ETH
   * @param expirationTime When the auction expires, or 0 if never.
   * @param orderSide Side of the order, either buy or sell
   * @param startAmount The base value for the order, in the token's main units (e.g. ETH instead of wei)
   * @param endAmount The end value for the order, in the token's main units (e.g. ETH instead of wei). If unspecified, the order's `extra` attribute will be 0
   * @param waitingForBestCounterOrder Whether the order is a "best counter order" or not
   * @param englishAuctionReservePrice The reserve price for an English auction
   */
  private async _getPriceParameters(
    orderSide: OrderSide,
    expirationTime: BigNumber,
    startAmount: BigNumber,
    endAmount?: BigNumber,
    tokenData?: TokenData,
    waitingForBestCounterOrder = false,
    englishAuctionReservePrice?: BigNumber
  ) {
    const priceDiff =
      endAmount != null ? startAmount.minus(endAmount) : new BigNumber(0);
    const isEther = !tokenData;
    const token: OpenSeaFungibleToken = tokenData
      ? tokenFromJSON(tokenData)
      : tokenFromJSON({
          address: NULL_ADDRESS,
          decimals: 18,
          symbol: "ETH",
        });
    const address = token.address;
    // Validation
    if (startAmount.isNaN() || startAmount.lt(0)) {
      throw new Error(`Starting price must be a number >= 0`);
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

    const basePrice = isEther
      ? makeBigNumber(
          ethers.utils.parseEther(startAmount.toString()).toString()
        ).integerValue()
      : OpenSeaSDK.toBaseUnitAmount(startAmount, token.decimals);

    const endPrice = endAmount
      ? isEther
        ? makeBigNumber(
            ethers.utils.parseEther(endAmount.toString()).toString()
          ).integerValue()
        : OpenSeaSDK.toBaseUnitAmount(endAmount, token.decimals)
      : undefined;

    const extra = isEther
      ? makeBigNumber(
          ethers.utils.parseEther(priceDiff.toString()).toString()
        ).integerValue()
      : OpenSeaSDK.toBaseUnitAmount(priceDiff, token.decimals);

    const reservePrice = englishAuctionReservePrice
      ? isEther
        ? makeBigNumber(
            ethers.utils
              .parseEther(englishAuctionReservePrice.toString())
              .toString()
          ).integerValue()
        : OpenSeaSDK.toBaseUnitAmount(
            englishAuctionReservePrice,
            token.decimals
          )
      : undefined;

    return { basePrice, extra, address, reservePrice, endPrice };
  }

  private _getSchemaName(asset: Asset | OpenSeaAsset) {
    if (asset.schemaName) {
      return asset.schemaName;
    } else if ("assetContract" in asset) {
      return asset.assetContract.schemaName;
    }

    return undefined;
  }

  private async _confirmTransaction(
    transactionHash: string,
    description: string,
    testForSuccess?: () => Promise<boolean>
  ): Promise<void> {
    this.logger(`Transaction started: ${description}`);

    if (transactionHash == NULL_BLOCK_HASH) {
      // This was a smart contract wallet that doesn't know the transaction

      if (!testForSuccess) {
        // Wait if test not implemented
        this.logger(`Unknown action, waiting 1 minute: ${description}`);
        await delay(60 * 1000);
        return;
      }

      return await this._pollCallbackForConfirmation(
        description,
        testForSuccess
      );
    }

    // Normal wallet
    try {
      await confirmTransaction(this.ethersProvider, transactionHash);
      this.logger(`Transaction succeeded: ${description}`);
    } catch (error) {
      this.logger(`Transaction failed: ${description}`);
      throw error;
    }
  }

  private async _pollCallbackForConfirmation(
    description: string,
    testForSuccess: () => Promise<boolean>
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const initialRetries = 60;

      const testResolve: (r: number) => Promise<void> = async (retries) => {
        const wasSuccessful = await testForSuccess();
        if (wasSuccessful) {
          this.logger(`Transaction succeeded: ${description}`);
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
