"""Buy an SPL token on Solana through the Jupiter aggregator.

Flow: quote SOL -> token, ask Jupiter to build the swap transaction,
sign it locally, submit to the RPC, and confirm.
"""
import asyncio
import base64
import logging

import aiohttp
import base58
from solders.keypair import Keypair
from solders.transaction import VersionedTransaction

import config
from sniper import chains

log = logging.getLogger("solana_buyer")

SOL_MINT = "So11111111111111111111111111111111111111112"
QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote"
SWAP_URL = "https://lite-api.jup.ag/swap/v1/swap"
LAMPORTS_PER_SOL = 1_000_000_000


async def buy(token_mint: str, amount_sol: float) -> str:
    """Swap `amount_sol` SOL for `token_mint`. Returns the tx signature."""
    if not config.SOLANA_PRIVATE_KEY:
        raise RuntimeError("SOLANA_PRIVATE_KEY is not set")

    keypair = Keypair.from_bytes(base58.b58decode(config.SOLANA_PRIVATE_KEY))
    rpc = config.rpc_url("solana", chains.SOLANA_DEFAULT_RPC)
    lamports = int(amount_sol * LAMPORTS_PER_SOL)

    async with aiohttp.ClientSession(trust_env=True) as session:
        params = {
            "inputMint": SOL_MINT,
            "outputMint": token_mint,
            "amount": str(lamports),
            "slippageBps": str(config.SLIPPAGE_BPS),
        }
        async with session.get(QUOTE_URL, params=params, timeout=aiohttp.ClientTimeout(total=10)) as resp:
            quote = await resp.json()
            if resp.status != 200 or "error" in quote:
                raise RuntimeError(f"Jupiter quote failed: {quote}")

        swap_body = {
            "quoteResponse": quote,
            "userPublicKey": str(keypair.pubkey()),
            "wrapAndUnwrapSol": True,
            "dynamicComputeUnitLimit": True,
            "prioritizationFeeLamports": {"priorityLevelWithMaxLamports": {
                "priorityLevel": "high", "maxLamports": 2_000_000,
            }},
        }
        async with session.post(SWAP_URL, json=swap_body, timeout=aiohttp.ClientTimeout(total=10)) as resp:
            swap = await resp.json()
            if resp.status != 200 or "swapTransaction" not in swap:
                raise RuntimeError(f"Jupiter swap build failed: {swap}")

        raw = VersionedTransaction.from_bytes(base64.b64decode(swap["swapTransaction"]))
        signed = VersionedTransaction(raw.message, [keypair])

        send_payload = {
            "jsonrpc": "2.0", "id": 1, "method": "sendTransaction",
            "params": [
                base64.b64encode(bytes(signed)).decode(),
                {"encoding": "base64", "skipPreflight": False, "maxRetries": 3},
            ],
        }
        async with session.post(rpc, json=send_payload, timeout=aiohttp.ClientTimeout(total=15)) as resp:
            result = await resp.json()
            if "error" in result:
                raise RuntimeError(f"sendTransaction failed: {result['error']}")
            signature = result["result"]

        log.info("[Solana] buy sent: %s", signature)
        await _confirm(session, rpc, signature)
        return signature


async def _confirm(session: aiohttp.ClientSession, rpc: str, signature: str, tries: int = 30) -> None:
    payload = {
        "jsonrpc": "2.0", "id": 1, "method": "getSignatureStatuses",
        "params": [[signature], {"searchTransactionHistory": True}],
    }
    for _ in range(tries):
        await asyncio.sleep(2)
        try:
            async with session.post(rpc, json=payload, timeout=aiohttp.ClientTimeout(total=6)) as resp:
                status = ((await resp.json()).get("result", {}).get("value") or [None])[0]
        except (aiohttp.ClientError, asyncio.TimeoutError):
            continue
        if status:
            if status.get("err"):
                raise RuntimeError(f"Solana transaction failed: {status['err']}")
            if status.get("confirmationStatus") in ("confirmed", "finalized"):
                return
    raise RuntimeError(f"Solana transaction not confirmed in time: {signature}")
