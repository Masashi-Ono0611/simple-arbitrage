# Mainnet Monitoring Guide (SEARCH_ONLY)

This guide describes how to monitor for crossed markets on Ethereum mainnet without deploying BundleExecutor and without sending any transactions.

## What this mode does

- Connects to a mainnet RPC (e.g. Alchemy)
- Loads a small whitelist of pools
- Updates reserves on each new block
- Prints crossed-market candidates when they exist

## What this mode does NOT do

- Deploy BundleExecutor
- Require funding WETH
- Submit bundles to Flashbots
- Send any transactions

## Prerequisites

- Node.js + npm
- A mainnet RPC URL (e.g. `ALCHEMY_ETHEREUM_RPC_URL`)

## Run monitoring (recommended: whitelist)

Important: arbitrage detection requires at least two markets for the same token (for example, Uniswap and Sushiswap for WETH/USDC). If you whitelist only one pair, the bot will have nothing to compare.

Example (monitor Uniswap + Sushiswap WETH/USDC):

```sh
set -a
source .env
set +a

export SEARCH_ONLY=1
export ETHEREUM_RPC_URL="$ALCHEMY_ETHEREUM_RPC_URL"
export MONITORED_PAIR_ADDRESSES_WHITELIST=0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc,0x397FF1542f962076d0BFE58eA045FfA2d347ACa0

npm run build
npm run start
```

Expected logs:

- `SEARCH_ONLY mode enabled: ...`
- `Updating markets, count: 2`
- `Candidate: profitWei=...` (only when a crossed market exists)

## Tips

- If you see `Updating markets, count: 0`, check `MONITORED_PAIR_ADDRESSES_WHITELIST` and ensure you included at least two markets for the same token.
