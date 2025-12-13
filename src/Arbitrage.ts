import * as _ from "lodash";
import { BigNumber, Contract, Wallet } from "ethers";
import { FlashbotsBundleProvider } from "@flashbots/ethers-provider-bundle";
import { WETH_ADDRESS } from "./addresses";
import { EthMarket } from "./EthMarket";
import { ETHER, bigNumberToDecimal } from "./utils";

export interface CrossedMarketDetails {
  profit: BigNumber,
  volume: BigNumber,
  tokenAddress: string,
  buyFromMarket: EthMarket,
  sellToMarket: EthMarket,
}

export type MarketsByToken = { [tokenAddress: string]: Array<EthMarket> }

const MIN_PROFIT_WEI = BigNumber.from(
  process.env.ARBITRAGE_MIN_PROFIT_WEI_THRESHOLD ||
  ETHER.div(1000).toString()
)

const DEBUG_ARBITRAGE = process.env.ARBITRAGE_LOG_ENABLED === "1"
const DEBUG_TOP_N = parseInt(process.env.ARBITRAGE_LOG_TOP_N || "5", 10)
const DEBUG_ARBITRAGE_VERBOSE = process.env.ARBITRAGE_LOG_VERBOSE === "1"

const DEBUG_LOCAL_SIMULATION = process.env.FORK_SIMULATE_LOCALLY === "1"
const DEBUG_LOCAL_EXECUTION = process.env.FORK_EXECUTE_LOCALLY === "1"
const DEBUG_EXECUTE_EVERY_N_BLOCKS = parseInt(
  process.env.FORK_EXECUTE_EVERY_N_BLOCKS ||
  "1",
  10
)

// TODO: implement binary search (assuming linear/exponential global maximum profitability)
const TEST_VOLUMES = [
  ETHER.div(100),
  ETHER.div(10),
  ETHER.div(6),
  ETHER.div(4),
  ETHER.div(2),
  ETHER.div(1),
  ETHER.mul(2),
  ETHER.mul(5),
  ETHER.mul(10),
]

export function getBestCrossedMarket(crossedMarkets: Array<EthMarket>[], tokenAddress: string): CrossedMarketDetails | undefined {
  let bestCrossedMarket: CrossedMarketDetails | undefined = undefined;
  for (const crossedMarket of crossedMarkets) {
    const sellToMarket = crossedMarket[0]
    const buyFromMarket = crossedMarket[1]
    for (const size of TEST_VOLUMES) {
      const tokensOutFromBuyingSize = buyFromMarket.getTokensOut(WETH_ADDRESS, tokenAddress, size);
      const proceedsFromSellingTokens = sellToMarket.getTokensOut(tokenAddress, WETH_ADDRESS, tokensOutFromBuyingSize)
      const profit = proceedsFromSellingTokens.sub(size);
      if (bestCrossedMarket !== undefined && profit.lt(bestCrossedMarket.profit)) {
        // If the next size up lost value, meet halfway. TODO: replace with real binary search
        const trySize = size.add(bestCrossedMarket.volume).div(2)
        const tryTokensOutFromBuyingSize = buyFromMarket.getTokensOut(WETH_ADDRESS, tokenAddress, trySize);
        const tryProceedsFromSellingTokens = sellToMarket.getTokensOut(tokenAddress, WETH_ADDRESS, tryTokensOutFromBuyingSize)
        const tryProfit = tryProceedsFromSellingTokens.sub(trySize);
        if (tryProfit.gt(bestCrossedMarket.profit)) {
          bestCrossedMarket = {
            volume: trySize,
            profit: tryProfit,
            tokenAddress,
            sellToMarket,
            buyFromMarket
          }
        }
        break;
      }
      bestCrossedMarket = {
        volume: size,
        profit: profit,
        tokenAddress,
        sellToMarket,
        buyFromMarket
      }
    }
  }
  return bestCrossedMarket;
}

export class Arbitrage {
  private flashbotsProvider: FlashbotsBundleProvider;
  private bundleExecutorContract: Contract;
  private executorWallet: Wallet;

  constructor(executorWallet: Wallet, flashbotsProvider: FlashbotsBundleProvider, bundleExecutorContract: Contract) {
    this.executorWallet = executorWallet;
    this.flashbotsProvider = flashbotsProvider;
    this.bundleExecutorContract = bundleExecutorContract;
  }

  static printCrossedMarket(crossedMarket: CrossedMarketDetails): void {
    const buyTokens = crossedMarket.buyFromMarket.tokens
    const sellTokens = crossedMarket.sellToMarket.tokens
    console.log(
      `Profit: ${bigNumberToDecimal(crossedMarket.profit)} Volume: ${bigNumberToDecimal(crossedMarket.volume)}\n` +
      `${crossedMarket.buyFromMarket.protocol} (${crossedMarket.buyFromMarket.marketAddress})\n` +
      `  ${buyTokens[0]} => ${buyTokens[1]}\n` +
      `${crossedMarket.sellToMarket.protocol} (${crossedMarket.sellToMarket.marketAddress})\n` +
      `  ${sellTokens[0]} => ${sellTokens[1]}\n` +
      `\n`
    )
  }


  async evaluateMarkets(marketsByToken: MarketsByToken): Promise<Array<CrossedMarketDetails>> {
    const bestCrossedMarkets = new Array<CrossedMarketDetails>()

    const debugCandidates = new Array<CrossedMarketDetails>()
    let debugTokens = 0
    let debugTokensWithCrossed = 0
    let debugTokensWithPositiveBestProfit = 0

    for (const tokenAddress in marketsByToken) {
      debugTokens += 1
      const markets = marketsByToken[tokenAddress]
      const pricedMarkets = _.map(markets, (ethMarket: EthMarket) => {
        return {
          ethMarket: ethMarket,
          buyTokenPrice: ethMarket.getTokensIn(tokenAddress, WETH_ADDRESS, ETHER.div(100)),
          sellTokenPrice: ethMarket.getTokensOut(WETH_ADDRESS, tokenAddress, ETHER.div(100)),
        }
      });

      if (DEBUG_ARBITRAGE && DEBUG_ARBITRAGE_VERBOSE) {
        console.log(
          "Token Debug:" +
          " token=" + tokenAddress +
          " markets=" + pricedMarkets.length
        )
        for (const pm of pricedMarkets) {
          console.log(
            "Market:" +
            " addr=" + pm.ethMarket.marketAddress +
            " buyTokenPrice=" + pm.buyTokenPrice.toString() +
            " sellTokenPrice=" + pm.sellTokenPrice.toString()
          )
        }
      }

      const crossedMarkets = new Array<Array<EthMarket>>()
      for (const pricedMarket of pricedMarkets) {
        _.forEach(pricedMarkets, pm => {
          if (pm.sellTokenPrice.gt(pricedMarket.buyTokenPrice)) {
            crossedMarkets.push([pricedMarket.ethMarket, pm.ethMarket])
          }
        })
      }

      if (crossedMarkets.length > 0) {
        debugTokensWithCrossed += 1
      }

      const bestCrossedMarket = getBestCrossedMarket(crossedMarkets, tokenAddress);
      if (bestCrossedMarket !== undefined) {
        debugCandidates.push(bestCrossedMarket)
        if (bestCrossedMarket.profit.gt(0)) {
          debugTokensWithPositiveBestProfit += 1
        }
      }
      if (bestCrossedMarket !== undefined && bestCrossedMarket.profit.gt(MIN_PROFIT_WEI)) {
        bestCrossedMarkets.push(bestCrossedMarket)
      }
    }

    if (DEBUG_ARBITRAGE) {
      const sorted = debugCandidates.sort((a, b) => a.profit.lt(b.profit) ? 1 : a.profit.gt(b.profit) ? -1 : 0)
      const top = sorted.slice(0, Math.max(0, DEBUG_TOP_N))

      console.log(
        "Arbitrage Debug:" +
        " tokens=" + debugTokens +
        " tokensWithCrossedCandidates=" + debugTokensWithCrossed +
        " tokensWithPositiveBestProfit=" + debugTokensWithPositiveBestProfit +
        " minProfitWei=" + MIN_PROFIT_WEI.toString() +
        " topN=" + DEBUG_TOP_N
      )

      for (const c of top) {
        console.log(
          "Candidate:" +
          " profitWei=" + c.profit.toString() +
          " profitEth=" + bigNumberToDecimal(c.profit) +
          " volumeEth=" + bigNumberToDecimal(c.volume) +
          " token=" + c.tokenAddress +
          " buyMarket=" + c.buyFromMarket.marketAddress +
          " sellMarket=" + c.sellToMarket.marketAddress
        )
      }
    }

    bestCrossedMarkets.sort((a, b) => a.profit.lt(b.profit) ? 1 : a.profit.gt(b.profit) ? -1 : 0)
    return bestCrossedMarkets
  }

  // TODO: take more than 1
  async takeCrossedMarkets(bestCrossedMarkets: CrossedMarketDetails[], blockNumber: number, minerRewardPercentage: number): Promise<void> {
    if (DEBUG_LOCAL_EXECUTION && DEBUG_EXECUTE_EVERY_N_BLOCKS > 1 && (blockNumber % DEBUG_EXECUTE_EVERY_N_BLOCKS) !== 0) {
      console.log(`DEBUG_LOCAL_EXECUTION: skipping block=${blockNumber}, executeEveryN=${DEBUG_EXECUTE_EVERY_N_BLOCKS}`)
      return
    }

    for (const bestCrossedMarket of bestCrossedMarkets) {

      console.log("Send this much WETH", bestCrossedMarket.volume.toString(), "get this much profit", bestCrossedMarket.profit.toString())
      const buyCalls = await bestCrossedMarket.buyFromMarket.sellTokensToNextMarket(WETH_ADDRESS, bestCrossedMarket.volume, bestCrossedMarket.sellToMarket);
      const inter = bestCrossedMarket.buyFromMarket.getTokensOut(WETH_ADDRESS, bestCrossedMarket.tokenAddress, bestCrossedMarket.volume)
      const sellCallData = await bestCrossedMarket.sellToMarket.sellTokens(bestCrossedMarket.tokenAddress, inter, this.bundleExecutorContract.address);

      const targets: Array<string> = [...buyCalls.targets, bestCrossedMarket.sellToMarket.marketAddress]
      const payloads: Array<string> = [...buyCalls.data, sellCallData]
      console.log({targets, payloads})
      const minerReward = bestCrossedMarket.profit.mul(minerRewardPercentage).div(100);
      const transaction = await this.bundleExecutorContract.populateTransaction.uniswapWeth(bestCrossedMarket.volume, minerReward, targets, payloads, {
        gasPrice: BigNumber.from(0),
        gasLimit: BigNumber.from(1000000),
      });

      if (DEBUG_LOCAL_EXECUTION) {
        const provider = this.bundleExecutorContract.provider;
        const weth = new Contract(WETH_ADDRESS, ["function balanceOf(address) view returns (uint256)"], provider);
        const before: BigNumber = await weth.balanceOf(this.bundleExecutorContract.address);
        console.log("BundleExecutor WETH before:", before.toString())

        let gasLimit: BigNumber | undefined = undefined
        try {
          gasLimit = await provider.estimateGas({
            ...transaction,
            from: this.executorWallet.address,
          })
        } catch (e: any) {
          console.error("Local execution estimateGas failed", e?.reason || e?.message || e)
          continue
        }

        const signer = this.executorWallet.connect(provider)
        const feeData = await provider.getFeeData()
        const txRequest: any = {
          ...transaction,
          gasLimit: gasLimit.mul(2),
        }
        // Populate fees so anvil accepts the transaction (EIP-1559 or legacy)
        if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
          txRequest.maxFeePerGas = feeData.maxFeePerGas
          txRequest.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas
          delete txRequest.gasPrice
        } else if (feeData.gasPrice) {
          txRequest.gasPrice = feeData.gasPrice
          delete txRequest.maxFeePerGas
          delete txRequest.maxPriorityFeePerGas
        }

        let sent
        try {
          sent = await signer.sendTransaction(txRequest)
        } catch (e: any) {
          console.error("Local execution sendTransaction failed", e?.reason || e?.message || e)
          const errData = e?.error?.data || e?.data
          if (errData) {
            console.error("Local execution error data:", errData)
          }
          continue
        }

        console.log("Local execution txHash:", sent.hash)
        const receipt = await sent.wait()
        console.log("Local execution receipt status:", receipt.status)

        const after: BigNumber = await weth.balanceOf(this.bundleExecutorContract.address);
        console.log("BundleExecutor WETH after:", after.toString())
        console.log("BundleExecutor WETH diff:", after.sub(before).toString())
        return
      }

      if (DEBUG_LOCAL_SIMULATION) {
        const provider = this.bundleExecutorContract.provider;
        try {
          const estimateGas = await provider.estimateGas({
            ...transaction,
            from: this.executorWallet.address,
          })
          console.log("Local estimateGas:", estimateGas.toString())
        } catch (e: any) {
          console.error("Local estimateGas failed", e?.reason || e?.message || e)
        }

        try {
          const callResult = await provider.call({
            ...transaction,
            from: this.executorWallet.address,
          })
          console.log("Local call (success), returnData:", callResult)
        } catch (e: any) {
          const errData = e?.error?.data || e?.data
          console.error("Local call failed", e?.reason || e?.message || e)
          if (errData) {
            console.error("Local call error data:", errData)
          }
        }
        continue
      }

      try {
        const estimateGas = await this.bundleExecutorContract.provider.estimateGas(
          {
            ...transaction,
            from: this.executorWallet.address
          })
        if (estimateGas.gt(1400000)) {
          console.log("EstimateGas succeeded, but suspiciously large: " + estimateGas.toString())
          continue
        }
        transaction.gasLimit = estimateGas.mul(2)
      } catch (e) {
        console.warn(`Estimate gas failure for ${JSON.stringify(bestCrossedMarket)}`)
        continue
      }
      const bundledTransactions = [
        {
          signer: this.executorWallet,
          transaction: transaction
        }
      ];
      console.log(bundledTransactions)
      const signedBundle = await this.flashbotsProvider.signBundle(bundledTransactions)
      //
      const simulation = await this.flashbotsProvider.simulate(signedBundle, blockNumber + 1 )
      if ("error" in simulation || simulation.firstRevert !== undefined) {
        console.log(`Simulation Error on token ${bestCrossedMarket.tokenAddress}, skipping`)
        continue
      }
      console.log(`Submitting bundle, profit sent to miner: ${bigNumberToDecimal(simulation.coinbaseDiff)}, effective gas price: ${bigNumberToDecimal(simulation.coinbaseDiff.div(simulation.totalGasUsed), 9)} GWEI`)
      const bundlePromises =  _.map([blockNumber + 1, blockNumber + 2], targetBlockNumber =>
        this.flashbotsProvider.sendRawBundle(
          signedBundle,
          targetBlockNumber
        ))
      await Promise.all(bundlePromises)
      return
    }
    if (DEBUG_LOCAL_SIMULATION) {
      console.warn("DEBUG_LOCAL_SIMULATION enabled: no bundle submitted to relay")
      return
    }
    throw new Error("No arbitrage submitted to relay")
  }
}
