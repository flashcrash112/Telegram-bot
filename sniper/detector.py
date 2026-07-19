"""Extract contract addresses from message text and figure out which
blockchain each one lives on.

Chain detection strategy:
1. Address shape narrows it down: 0x + 40 hex chars = some EVM chain,
   32-44 base58 chars = Solana candidate.
2. DexScreener's token endpoint is asked which chain(s) the token has
   trading pairs on; the pair with the deepest liquidity wins. This also
   yields symbol/liquidity data used for safety checks.
3. If DexScreener has never seen the token (brand-new launch), EVM
   addresses are resolved by probing each chain's RPC for contract
   bytecode; Solana candidates are checked against the Solana RPC.
"""
import asyncio
import logging
import re
from dataclasses import dataclass, field

import aiohttp
import base58

from sniper import chains

log = logging.getLogger("detector")

EVM_RE = re.compile(r"\b0x[a-fA-F0-9]{40}\b")
# Base58 (no 0, O, I, l), typical Solana pubkey length.
SOLANA_RE = re.compile(r"\b[1-9A-HJ-NP-Za-km-z]{32,44}\b")

DEXSCREENER_TOKEN_URL = "https://api.dexscreener.com/latest/dex/tokens/{}"

# Frequent base58-looking strings that are not token mints.
SOLANA_IGNORE = {
    "So11111111111111111111111111111111111111112",   # wrapped SOL
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  # USDC
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",  # USDT
}


@dataclass
class Detection:
    address: str
    chain: str                      # dexscreener-style chain key, e.g. "ethereum", "solana"
    symbol: str = "?"
    name: str = "?"
    liquidity_usd: float = 0.0
    price_usd: str = "?"
    dex: str = "?"
    listed: bool = field(default=False)  # known to DexScreener


def extract_candidates(text: str) -> tuple[list[str], list[str]]:
    """Return (evm_candidates, solana_candidates) found in text."""
    evm = list(dict.fromkeys(m.group(0) for m in EVM_RE.finditer(text)))
    sol = []
    for m in SOLANA_RE.finditer(text):
        s = m.group(0)
        if s in SOLANA_IGNORE or s in sol:
            continue
        # Must decode to exactly 32 bytes to be a Solana pubkey.
        try:
            if len(base58.b58decode(s)) == 32:
                sol.append(s)
        except ValueError:
            continue
    return evm, sol


async def _dexscreener_lookup(session: aiohttp.ClientSession, address: str) -> Detection | None:
    """Ask DexScreener which chain the token trades on; pick the deepest pool."""
    try:
        async with session.get(
            DEXSCREENER_TOKEN_URL.format(address),
            timeout=aiohttp.ClientTimeout(total=8),
        ) as resp:
            if resp.status != 200:
                return None
            data = await resp.json()
    except (aiohttp.ClientError, asyncio.TimeoutError):
        log.warning("DexScreener lookup failed for %s", address)
        return None

    pairs = data.get("pairs") or []
    # Only pairs where this address is the traded token, not the quote side.
    pairs = [p for p in pairs if p.get("baseToken", {}).get("address", "").lower() == address.lower()]
    if not pairs:
        return None
    best = max(pairs, key=lambda p: (p.get("liquidity") or {}).get("usd") or 0)
    base_token = best.get("baseToken", {})
    return Detection(
        address=base_token.get("address", address),
        chain=best.get("chainId", ""),
        symbol=base_token.get("symbol", "?"),
        name=base_token.get("name", "?"),
        liquidity_usd=(best.get("liquidity") or {}).get("usd") or 0.0,
        price_usd=best.get("priceUsd", "?"),
        dex=best.get("dexId", "?"),
        listed=True,
    )


async def _probe_evm_chain(session: aiohttp.ClientSession, rpc: str, address: str) -> bool:
    """True if the address has contract bytecode on this chain."""
    payload = {"jsonrpc": "2.0", "id": 1, "method": "eth_getCode", "params": [address, "latest"]}
    try:
        async with session.post(rpc, json=payload, timeout=aiohttp.ClientTimeout(total=6)) as resp:
            if resp.status != 200:
                return False
            result = (await resp.json()).get("result", "0x")
            return isinstance(result, str) and len(result) > 2
    except (aiohttp.ClientError, asyncio.TimeoutError):
        return False


async def _probe_solana(session: aiohttp.ClientSession, address: str) -> bool:
    """True if the address is an SPL token mint on Solana."""
    import config

    rpc = config.rpc_url("solana", chains.SOLANA_DEFAULT_RPC)
    payload = {
        "jsonrpc": "2.0", "id": 1, "method": "getAccountInfo",
        "params": [address, {"encoding": "jsonParsed"}],
    }
    try:
        async with session.post(rpc, json=payload, timeout=aiohttp.ClientTimeout(total=6)) as resp:
            if resp.status != 200:
                return False
            value = (await resp.json()).get("result", {}).get("value")
            if not value:
                return False
            owner = value.get("owner", "")
            # SPL Token / Token-2022 program owns all mints.
            return owner in (
                "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
                "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
            )
    except (aiohttp.ClientError, asyncio.TimeoutError):
        return False


async def detect(text: str) -> list[Detection]:
    """Find every tradable token address in `text` with its chain resolved."""
    evm_candidates, sol_candidates = extract_candidates(text)
    if not evm_candidates and not sol_candidates:
        return []

    detections: list[Detection] = []
    async with aiohttp.ClientSession(trust_env=True) as session:
        for address in evm_candidates + sol_candidates:
            det = await _dexscreener_lookup(session, address)
            if det:
                detections.append(det)
                continue

            # Unknown to DexScreener — resolve chain the hard way.
            if address in evm_candidates:
                for key in chains.EVM_PROBE_ORDER:
                    chain = chains.EVM_CHAINS[key]
                    if await _probe_evm_chain(session, chain.rpc, address):
                        detections.append(Detection(address=address, chain=key))
                        break
                else:
                    log.info("EVM address %s has no bytecode on any supported chain; skipping", address)
            else:
                if await _probe_solana(session, address):
                    detections.append(Detection(address=address, chain=chains.SOLANA_KEY))
    return detections
