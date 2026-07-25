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
| Robinhood Chain | ✅ | Relay (no public V2 router on-chain yet) |
| Avalanche | ✅ | Trader Joe |
| Solana | ✅ | Jupiter aggregator (best route across all Solana DEXes) |

Before enabling buys on a newly added chain (e.g. Robinhood Chain), verify
its config against the live network:

```bash
npm run verify:chain robinhood
```

Every check must PASS. If the router checks fail, set `ROUTER_<KEY>` in
`.env` to the chain's canonical UniswapV2 router and re-run.

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

## Buy engines

Two ways to execute buys, chosen with `BUY_ENGINE` in `.env`:

- **`native`** (default): swaps directly on each chain's own DEX router.
  Fastest execution, but you must hold the native gas coin on every chain you
  want to buy on (ETH, BNB, POL, AVAX, SOL, …).
- **`relay`**: cross-chain buys via [Relay](https://relay.link). You fund
  **one wallet on one chain** (`RELAY_ORIGIN_CHAIN`, e.g. ETH on Base) and
  Relay's solvers deliver the token on whatever chain it lives on — including
  SPL tokens on Solana (set `SOLANA_RECIPIENT`, or it defaults to your
  `SOLANA_PRIVATE_KEY`'s pubkey). Much simpler treasury management, at the
  cost of a small relay fee and a few extra seconds per fill.

The engine can also be set per chain with `BUY_ENGINE_<KEY>` (e.g.
`BUY_ENGINE_ROBINHOOD=native`). Robinhood Chain defaults to the relay engine
because no public UniswapV2 router is deployed there.

## Setup

Requires Node.js 20+.

```bash
npm install
npm run build
```

Then edit `.env`:

1. **Telegram**: create an app at <https://my.telegram.org> → API development
   tools, copy `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`. This uses your *user
   account* (via GramJS/MTProto), not a bot — bots can't read channels they
   aren't admin of.
2. **Chats**: set `TARGET_CHATS` to the groups/channels to watch, e.g.
   `@alphacalls,@gemchannel,-1001234567890`.
3. **Wallets**: `EVM_PRIVATE_KEY` (used on all EVM chains) and/or
   `SOLANA_PRIVATE_KEY` (base58 secret key). **Use a dedicated hot wallet with
   only the funds you're willing to lose — never your main wallet.**
4. **Buy amounts**: `BUY_AMOUNT_<CHAIN>` in the chain's native coin
   (ETH, BNB, SOL, …). Set `0` to disable buying on a chain.
5. **Market-cap-tiered sizing** (optional): `BUY_TIERS_USD` sizes buys in
   USD by the token's market cap, overriding the fixed amounts, e.g.

   ```
   BUY_TIERS_USD=50000:50,100000:100,200000:150,500000:200,1000000:250,default:300
   ```

   means under $50k mcap buy $50, $50–100k buy $100, …, above $1m buy
   $300. The USD size is converted to the native coin at the token's
   current DexScreener prices. Falls back to the fixed amounts when the
   market cap or native price is unknown, or when a Relay buy's origin
   coin differs from the destination chain's native coin.

## Run

```bash
node dist/main.js
```

The first run asks for your phone number and a login code to create the
Telegram session (stored in a folder named after `TELEGRAM_SESSION`). After
that it runs unattended.

### Scanning with multiple Telegram accounts

Set `TELEGRAM_SESSIONS` to a comma-separated list of session names, e.g.
`TELEGRAM_SESSIONS=sniper,alt`. Each name is a separate login (own phone
number); on the next foreground run (`node dist/main.js`) any session
without saved credentials asks for its login interactively, prefixed with
the session name. All accounts share `TARGET_CHATS`, the detection
pipeline, and duplicate protection — a token seen by several accounts is
bought once. One `TELEGRAM_API_ID`/`HASH` pair works for all accounts.
The `.gitignore` covers the default `sniper` session folder; add a line
for each extra session folder name (e.g. `/alt/`).

To find the numeric IDs of private groups/channels for `TARGET_CHATS`:

```bash
npm run chats
```

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

## Running 24/7 on a VPS

Install Node.js 20+ first (Ubuntu/Debian):

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
```

After the first interactive run (which creates the Telegram session),
install the bot as a systemd service so it survives reboots and crashes:

```bash
cp deploy/sniper.service /etc/systemd/system/sniper.service
# edit the paths in the file if you didn't clone to /root/Telegram-bot
systemctl daemon-reload
systemctl enable --now sniper
```

### Migrating a VPS from the old Python version

The bot was originally written in Python; if your VPS still runs that
version, upgrade it like this:

```bash
systemctl stop sniper
cd /root/Telegram-bot
git pull
# install Node.js 20+ (see above), then:
npm install
npm run build
node dist/main.js        # interactive: log in to Telegram again (new session format)
# Ctrl+C once it says "sniper running", then:
cp deploy/sniper.service /etc/systemd/system/sniper.service
systemctl daemon-reload
systemctl restart sniper
```

Your `.env` keeps working unchanged. The old Telethon `sniper.session` file
is not compatible with GramJS, which is why the one-time interactive login is
needed again.

Useful commands:

```bash
journalctl -u sniper -f     # watch live logs
systemctl status sniper     # is it running?
systemctl restart sniper    # restart after editing .env
systemctl stop sniper       # stop it (e.g. to pause trading)
```

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

## Taking profit

The bot tracks every token it buys as a position and can exit it
automatically:

```
TAKE_PROFIT_TIERS=2:50,5:30,10:20   # at 2x sell 50% of the original
                                    # position, at 5x another 30%,
                                    # at 10x the last 20%
STOP_LOSS_PCT=50                    # sell everything at -50% (0 = off)
POSITION_POLL_SECONDS=30            # how often prices are checked
```

Percentages are always of the *original* position, so a ladder adds up
to at most 100. A price that gaps past several rungs at once consumes
all of them in a single sale. Leave `TAKE_PROFIT_TIERS` empty and
`STOP_LOSS_PCT=0` to disable selling entirely — the monitor then never
starts and the bot only buys.

Exits use the same engines as entries: Jupiter on Solana, the chain's
router on native EVM chains, and Relay for chains routed through it
(Robinhood Chain). **A Relay sell signs transactions on the token's own
chain, so the wallet needs a little native coin there for gas** — bridge
some once before relying on take-profit for those chains.

In `DRY_RUN` mode buys open *paper* positions and exits are logged as
`DRY RUN: would sell ...` — a complete paper-trading record of entries,
exits and multiples, with no funds at risk.

Inspect positions any time:

```bash
npm run positions        # open positions with their current multiple
npm run positions -- all # include closed ones
```

Tokens that repeatedly fail to sell (honeypots, or a chain with no gas)
are retried a few times, then logged loudly and left alone for manual
handling rather than burning gas forever.
