"""Environment-driven configuration."""
import os

from dotenv import load_dotenv

load_dotenv()


def _bool(name: str, default: bool) -> bool:
    return os.getenv(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


def _float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, "") or default)
    except ValueError:
        return default


TELEGRAM_API_ID = int(os.getenv("TELEGRAM_API_ID", "0"))
TELEGRAM_API_HASH = os.getenv("TELEGRAM_API_HASH", "")
TELEGRAM_SESSION = os.getenv("TELEGRAM_SESSION", "sniper")

TARGET_CHATS = [c.strip() for c in os.getenv("TARGET_CHATS", "").split(",") if c.strip()]

DRY_RUN = _bool("DRY_RUN", True)
MIN_LIQUIDITY_USD = _float("MIN_LIQUIDITY_USD", 5000)
ALLOW_UNLISTED = _bool("ALLOW_UNLISTED", False)
SLIPPAGE_BPS = int(_float("SLIPPAGE_BPS", 300))

EVM_PRIVATE_KEY = os.getenv("EVM_PRIVATE_KEY", "").strip()
SOLANA_PRIVATE_KEY = os.getenv("SOLANA_PRIVATE_KEY", "").strip()

# "native" = swap on each chain's own DEX router (needs gas coins everywhere).
# "relay"  = fund one origin chain and buy cross-chain via relay.link.
BUY_ENGINE = os.getenv("BUY_ENGINE", "native").strip().lower()
RELAY_ORIGIN_CHAIN = os.getenv("RELAY_ORIGIN_CHAIN", "base").strip().lower()
RELAY_BUY_AMOUNT = _float("RELAY_BUY_AMOUNT", 0.0)
# Solana address that receives SPL tokens on cross-chain buys; falls back
# to the pubkey derived from SOLANA_PRIVATE_KEY.
SOLANA_RECIPIENT = os.getenv("SOLANA_RECIPIENT", "").strip()

SEEN_TOKENS_FILE = os.getenv("SEEN_TOKENS_FILE", "seen_tokens.json")

# Log every message the bot receives (chat + first chars). Handy when
# verifying the bot actually sees a chat; turn off for normal running.
DEBUG_LOG_MESSAGES = _bool("DEBUG_LOG_MESSAGES", False)

# ---------- Message sources ----------
# Turn each source on/off. Telegram uses the TELEGRAM_* settings above.
ENABLE_TELEGRAM = _bool("ENABLE_TELEGRAM", True)
ENABLE_DISCORD = _bool("ENABLE_DISCORD", False)

# Discord: "bot" (official, safe, invite-only) or "user" (user token, reads
# any server you're in, but violates Discord ToS — ban risk).
DISCORD_MODE = os.getenv("DISCORD_MODE", "user").strip().lower()
DISCORD_BOT_TOKEN = os.getenv("DISCORD_BOT_TOKEN", "").strip()
DISCORD_USER_TOKEN = os.getenv("DISCORD_USER_TOKEN", "").strip()
# Numeric channel IDs to watch. Empty = every channel the account sees.
DISCORD_CHANNELS = [
    int(c) for c in os.getenv("DISCORD_CHANNELS", "").replace(" ", "").split(",") if c.strip().isdigit()
]

# Chains to act on, e.g. "ethereum,solana". Empty = all supported chains.
# Detections on other chains are logged but never bought, and EVM RPC
# probing is limited to the enabled chains.
ENABLED_CHAINS = [
    c.strip().lower() for c in os.getenv("ENABLED_CHAINS", "").split(",") if c.strip()
]


def buy_amount(chain_key: str) -> float:
    """Native-coin buy amount for a chain, e.g. buy_amount('bsc') -> BUY_AMOUNT_BSC."""
    return _float(f"BUY_AMOUNT_{chain_key.upper()}", 0.0)


def rpc_url(chain_key: str, default: str) -> str:
    return os.getenv(f"RPC_{chain_key.upper()}", "") or default
