# Telegram Contract Sniper

Listens to Telegram groups/channels, extracts crypto contract addresses from
messages, **auto-detects which blockchain** each address is on, and buys the
token immediately.

## Supported chains

| Chain | Detection | Buying via |
|---|---|---|
| Ethereum | ✅ | Uniswap V2 |
| BNB Chain | ✅ | PancakeSwap V2 |
| Base | ✅ | Uniswap V2 |
| Arbitrum | ✅ | SushiSwap |
| Polygon | ✅ | QuickSwap |
| Avalanche | ✅ | Trader Joe |
| Solana | ✅ | Jupiter aggregator (best route across all Solana DEXes) |

## How chain detection works

1. **Address shape**: `0x` + 40 hex chars → an EVM chain; 32–44 base58 chars
   that decode to 32 bytes → Solana candidate.
2. **DexScreener lookup**: the token address is queried against DexScreener,
   which reports every chain the token has trading pairs on. The pair with the
   deepest liquidity decides the chain, and the liquidity number feeds the
   safety check.
3. **RPC probing fallback**: if DexScreener has never seen the token (a
   brand-new launch), each EVM chain's RPC is asked for contract bytecode at
   that address (`eth_getCode`); Solana candidates are verified as SPL token
   mints via `getAccountInfo`.

## Setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Then edit `.env`:

1. **Telegram**: create an app at <https://my.telegram.org> → API development
   tools, copy `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`. This uses your *user
   account* (via Telethon), not a bot — bots can't read channels they aren't
   admin of.
2. **Chats**: set `TARGET_CHATS` to the groups/channels to watch, e.g.
   `@alphacalls,@gemchannel,-1001234567890`.
3. **Wallets**: `EVM_PRIVATE_KEY` (used on all EVM chains) and/or
   `SOLANA_PRIVATE_KEY` (base58 secret key). **Use a dedicated hot wallet with
   only the funds you're willing to lose — never your main wallet.**
4. **Buy amounts**: `BUY_AMOUNT_<CHAIN>` in the chain's native coin
   (ETH, BNB, SOL, …). Set `0` to disable buying on a chain.

## Run

```bash
python main.py
```

The first run asks for your phone number and a login code to create the
Telegram session file. After that it runs unattended.

**Start in dry-run mode** (the default, `DRY_RUN=true`): the bot logs every
detection and what it *would* buy, without sending transactions. Watch it for a
day, then set `DRY_RUN=false` when you're confident in the settings.

## Safety features

- `DRY_RUN=true` by default — nothing is bought until you flip it.
- `MIN_LIQUIDITY_USD` — skips tokens whose deepest pool is below the threshold
  (thin pools mean huge price impact and likely rugs).
- `ALLOW_UNLISTED=false` — skips tokens DexScreener doesn't know yet.
- `SLIPPAGE_BPS` — caps slippage; EVM buys use `getAmountsOut` minus slippage
  as the minimum output, Solana buys pass it to Jupiter.
- Duplicate protection — each token is only ever bought once
  (persisted in `seen_tokens.json`).
- Fee-on-transfer-safe swap function on EVM, so taxed tokens don't revert.

## ⚠️ Read this before going live

Auto-buying contract addresses posted in Telegram is **one of the riskiest
things you can do with a wallet**:

- Many "call channels" are paid promotions or coordinated pump-and-dumps where
  the posters sell into your buy.
- Honeypot tokens let you buy but not sell. The liquidity check reduces but
  does not eliminate this risk — consider adding a honeypot-checker API before
  going live with real size.
- A leaked `.env` = a drained wallet. The private keys sit in plaintext; keep
  the machine clean and the wallet small.
- Public RPCs are slow; for real sniping use paid/private RPC endpoints.

Use small amounts, a throwaway wallet, and expect to lose what you deploy.
