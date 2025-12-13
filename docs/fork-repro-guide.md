# Fork Reproduction Guide (WETH/USDC, Uniswap vs Sushiswap)

This guide describes a minimal, repeatable way to reproduce the successful flow on a local mainnet fork:

- Create a price imbalance on Uniswap (WETH/USDC)
- Let the bot detect a crossed market
- Execute the arbitrage locally on the fork
- Confirm the BundleExecutor WETH balance increases

## Prerequisites

- Anvil running a mainnet fork on `http://127.0.0.1:8545` (chainId `31337`)
- A funded local EOA (Anvil account(0) is fine)
- BundleExecutor deployed on the fork

## 1) Configure `.env`

Set at least:

- `ETHEREUM_RPC_URL=http://127.0.0.1:8545`
- `PRIVATE_KEY=<anvil account(0) private key>`
- `BUNDLE_EXECUTOR_ADDRESS=<deployed BundleExecutor address>`

Recommended debug settings:

- `ARBITRAGE_MIN_PROFIT_WEI_THRESHOLD=1`
- `ARBITRAGE_LOG_ENABLED=1`
- `ARBITRAGE_LOG_TOP_N=5`
- `ARBITRAGE_LOG_VERBOSE=1`

Restrict monitoring to WETH/USDC only (reduces RPC load):

- `MONITORED_PAIR_ADDRESSES_WHITELIST=0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc,0x397FF1542f962076d0BFE58eA045FfA2d347ACa0`

Enable local execution (recommended on a fork):

- `FORK_SIMULATE_LOCALLY=0`
- `FORK_EXECUTE_LOCALLY=1`
- `FORK_EXECUTE_EVERY_N_BLOCKS=5`

Quick meaning:

- `ARBITRAGE_MIN_PROFIT_WEI_THRESHOLD=1` means “almost no profit threshold” (good for experiments).
- `ARBITRAGE_LOG_ENABLED=1` enables arbitrage debug logs.
- `ARBITRAGE_LOG_TOP_N=5` prints the top 5 candidates.
- `ARBITRAGE_LOG_VERBOSE=1` prints per-market pricing details (more logs).
- `FORK_SIMULATE_LOCALLY=0` disables “simulate only”. If set to `1`, it runs `estimateGas`/`call` without changing chain state.
- `FORK_EXECUTE_LOCALLY=1` sends a normal transaction to Anvil (changes chain state).
- `FORK_EXECUTE_EVERY_N_BLOCKS=5` throttles execution attempts.

## 2) Fund the BundleExecutor with WETH (setup before creating imbalance)

The BundleExecutor needs WETH as starting capital.

1) Ensure your EOA has WETH (deposit ETH -> WETH if needed).
2) Transfer WETH to the BundleExecutor.

Example (transfer 50 WETH):

```sh
WETH=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
AMT=50000000000000000000

cast send --json --rpc-url http://127.0.0.1:8545 --private-key "$PRIVATE_KEY" \
  $WETH "transfer(address,uint256)(bool)" $BUNDLE_EXECUTOR_ADDRESS $AMT
```

Verify:

```sh
cast call $WETH "balanceOf(address)(uint256)" $BUNDLE_EXECUTOR_ADDRESS --rpc-url http://127.0.0.1:8545
```

## 3) Create the price imbalance on Uniswap (trigger for detection)

Do a large WETH -> USDC swap on Uniswap V2 Router.

Example (swap 10 WETH):

```sh
WETH=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
USDC=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
ROUTER=0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D
ME=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
AMT=10000000000000000000

DEADLINE=$(python3 - << 'PY'
import time
print(int(time.time()) + 3600)
PY
)

cast send --json --rpc-url http://127.0.0.1:8545 --private-key "$PRIVATE_KEY" \
  $ROUTER "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)" \
  $AMT 0 "[${WETH},${USDC}]" $ME $DEADLINE
```

If the bot does not detect anything, increase the swap size.

## 4) Run the bot

```sh
npm run build
npm run start
```

Expected logs:

- `Updating markets, count: 2`
- `Arbitrage Debug: ... tokensWithCrossedCandidates=1 ...`
- `Candidate: profitWei=...`
- `Local execution txHash: 0x...`
- `Local execution receipt status: 1`
- `BundleExecutor WETH before: ...`
- `BundleExecutor WETH after: ...`
- `BundleExecutor WETH diff: ...` (should be positive)

## 5) Verify the transaction and balances

If you have the tx hash from the bot logs:

```sh
cast rpc eth_getTransactionReceipt <TX_HASH> --rpc-url http://127.0.0.1:8545
```

Confirm BundleExecutor WETH balance:

```sh
WETH=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
cast call $WETH "balanceOf(address)(uint256)" $BUNDLE_EXECUTOR_ADDRESS --rpc-url http://127.0.0.1:8545
```

## Notes

- On a fork (chainId 31337), Flashbots relay submission is not the goal. Flashbots is mainly for mainnet (chainId 1). Use `FORK_EXECUTE_LOCALLY=1`.
- After a successful arbitrage, the price imbalance can disappear, so the next blocks may show `No crossed markets`.
