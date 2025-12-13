import { FlashbotsBundleProvider } from "@flashbots/ethers-provider-bundle";
import { Contract, providers, Wallet } from "ethers";
import { BUNDLE_EXECUTOR_ABI } from "./abi";
import { UniswappyV2EthPair } from "./UniswappyV2EthPair";
import { FACTORY_ADDRESSES } from "./addresses";
import { Arbitrage } from "./Arbitrage";
import { get } from "https"
import { getDefaultRelaySigningKey } from "./utils";

const ETHEREUM_RPC_URL = process.env.ETHEREUM_RPC_URL || "http://127.0.0.1:8545"
const SEARCH_ONLY = process.env.SEARCH_ONLY === "1"
const PRIVATE_KEY = process.env.PRIVATE_KEY || ""
const BUNDLE_EXECUTOR_ADDRESS = process.env.BUNDLE_EXECUTOR_ADDRESS || ""

const FLASHBOTS_RELAY_SIGNING_KEY = process.env.FLASHBOTS_RELAY_SIGNING_KEY || getDefaultRelaySigningKey();

const MINER_REWARD_PERCENTAGE = parseInt(process.env.MINER_REWARD_PERCENTAGE || "80")

if (!SEARCH_ONLY) {
  if (PRIVATE_KEY === "") {
    console.warn("Must provide PRIVATE_KEY environment variable")
    process.exit(1)
  }
  if (BUNDLE_EXECUTOR_ADDRESS === "") {
    console.warn("Must provide BUNDLE_EXECUTOR_ADDRESS environment variable. Please see README.md")
    process.exit(1)
  }

  if (FLASHBOTS_RELAY_SIGNING_KEY === "") {
    console.warn("Must provide FLASHBOTS_RELAY_SIGNING_KEY. Please see https://github.com/flashbots/pm/blob/main/guides/searcher-onboarding.md")
    process.exit(1)
  }
}

const HEALTHCHECK_URL = process.env.HEALTHCHECK_URL || ""

const provider = new providers.StaticJsonRpcProvider(ETHEREUM_RPC_URL);

const arbitrageSigningWallet = SEARCH_ONLY ? Wallet.createRandom() : new Wallet(PRIVATE_KEY);
const flashbotsRelaySigningWallet = SEARCH_ONLY ? Wallet.createRandom() : new Wallet(FLASHBOTS_RELAY_SIGNING_KEY);

function createSearchOnlyArbitrage(): Arbitrage {
  const dummyFlashbotsProvider = {} as any
  const dummyBundleExecutorContract = new Contract(
    "0x0000000000000000000000000000000000000000",
    BUNDLE_EXECUTOR_ABI,
    provider
  )
  return new Arbitrage(arbitrageSigningWallet, dummyFlashbotsProvider, dummyBundleExecutorContract)
}

function healthcheck() {
  if (HEALTHCHECK_URL === "") {
    return
  }
  get(HEALTHCHECK_URL).on('error', console.error);
}

async function main() {
  if (SEARCH_ONLY) {
    console.log("SEARCH_ONLY mode enabled: will not deploy BundleExecutor and will not send transactions")
  }
  console.log("Searcher Wallet Address: " + await arbitrageSigningWallet.getAddress())
  let arbitrage: Arbitrage | null = null
  if (!SEARCH_ONLY) {
    console.log("Flashbots Relay Signing Wallet Address: " + await flashbotsRelaySigningWallet.getAddress())
    const flashbotsProvider = await FlashbotsBundleProvider.create(provider, flashbotsRelaySigningWallet);
    const bundleExecutorContract = new Contract(BUNDLE_EXECUTOR_ADDRESS, BUNDLE_EXECUTOR_ABI, provider)
    arbitrage = new Arbitrage(arbitrageSigningWallet, flashbotsProvider, bundleExecutorContract)
  } else {
    arbitrage = createSearchOnlyArbitrage()
  }

  const markets = await UniswappyV2EthPair.getUniswapMarketsByToken(provider, FACTORY_ADDRESSES);
  provider.on('block', async (blockNumber: number) => {
    await UniswappyV2EthPair.updateReserves(provider, markets.allMarketPairs);
    const bestCrossedMarkets = await arbitrage!.evaluateMarkets(markets.marketsByToken);
    if (bestCrossedMarkets.length === 0) {
      console.log("No crossed markets")
      return
    }
    bestCrossedMarkets.forEach(Arbitrage.printCrossedMarket);
    if (SEARCH_ONLY) {
      return
    }
    await arbitrage!.takeCrossedMarkets(bestCrossedMarkets, blockNumber, MINER_REWARD_PERCENTAGE).then(healthcheck).catch(console.error)
  })
}

main();
