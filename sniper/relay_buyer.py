"""Buy tokens on any supported chain from a single funding wallet, via
Relay (https://relay.link).

Instead of holding native gas coins on every chain, you fund ONE wallet
on ONE origin chain (e.g. ETH on Base). For each detected token, Relay
quotes a cross-chain swap: we sign and send the origin-chain
transaction(s) it returns, and Relay's solvers deliver the destination
token to the recipient — including SPL tokens on Solana.

Flow: POST /quote -> execute returned origin-chain tx steps -> poll the
status endpoint until the fill succeeds.
"""
import asyncio
import logging

import aiohttp
from web3 import Web3

import config
from sniper.chains import EVM_CHAINS, SOLANA_KEY

log = logging.getLogger("relay_buyer")

RELAY_API = "https://api.relay.link"
NATIVE_EVM = "0x0000000000000000000000000000000000000000"
# Relay's chain id for Solana mainnet.
RELAY_SOLANA_CHAIN_ID = 792703809

STATUS_POLL_SECONDS = 3
STATUS_POLL_TRIES = 60


def destination_chain_id(chain_key: str) -> int | None:
    if chain_key == SOLANA_KEY:
        return RELAY_SOLANA_CHAIN_ID
    chain = EVM_CHAINS.get(chain_key)
    return chain.chain_id if chain else None


def solana_recipient() -> str:
    """Where SPL tokens should land when buying a Solana token cross-chain."""
    if config.SOLANA_RECIPIENT:
        return config.SOLANA_RECIPIENT
    if config.SOLANA_PRIVATE_KEY:
        import base58
        from solders.keypair import Keypair

        return str(Keypair.from_bytes(base58.b58decode(config.SOLANA_PRIVATE_KEY)).pubkey())
    return ""


def build_quote_body(user: str, dest_chain_key: str, token_address: str, amount_wei: int) -> dict:
    origin = EVM_CHAINS[config.RELAY_ORIGIN_CHAIN]
    dest_id = destination_chain_id(dest_chain_key)
    if dest_id is None:
        raise RuntimeError(f"chain {dest_chain_key!r} is not supported via Relay")

    recipient = user
    if dest_chain_key == SOLANA_KEY:
        recipient = solana_recipient()
        if not recipient:
            raise RuntimeError(
                "Solana destination needs SOLANA_RECIPIENT or SOLANA_PRIVATE_KEY set"
            )

    return {
        "user": user,
        "recipient": recipient,
        "originChainId": origin.chain_id,
        "destinationChainId": dest_id,
        "originCurrency": NATIVE_EVM,
        "destinationCurrency": token_address,
        "amount": str(amount_wei),
        "tradeType": "EXACT_INPUT",
        "slippageTolerance": str(config.SLIPPAGE_BPS),
    }


async def buy(dest_chain_key: str, token_address: str, amount_origin_native: float) -> str:
    """Swap `amount_origin_native` of the origin chain's native coin into
    `token_address` on `dest_chain_key`. Returns the last origin tx hash.
    """
    if not config.EVM_PRIVATE_KEY:
        raise RuntimeError("EVM_PRIVATE_KEY is not set (Relay origin wallet)")

    origin = EVM_CHAINS[config.RELAY_ORIGIN_CHAIN]
    w3 = Web3(Web3.HTTPProvider(origin.rpc, request_kwargs={"timeout": 15}))
    account = w3.eth.account.from_key(config.EVM_PRIVATE_KEY)
    amount_wei = w3.to_wei(amount_origin_native, "ether")

    balance = await asyncio.to_thread(w3.eth.get_balance, account.address)
    if balance < amount_wei:
        raise RuntimeError(
            f"insufficient {origin.native_symbol} on {origin.name}: "
            f"have {w3.from_wei(balance, 'ether')}, need {amount_origin_native} plus gas"
        )

    body = build_quote_body(account.address, dest_chain_key, token_address, amount_wei)

    async with aiohttp.ClientSession(trust_env=True) as session:
        async with session.post(
            f"{RELAY_API}/quote", json=body, timeout=aiohttp.ClientTimeout(total=15)
        ) as resp:
            quote = await resp.json()
            if resp.status != 200:
                raise RuntimeError(f"Relay quote failed ({resp.status}): {quote}")

        tx_hash = ""
        check_endpoints: list[str] = []
        for step in quote.get("steps", []):
            if step.get("kind") != "transaction":
                continue
            for item in step.get("items", []):
                data = item.get("data") or {}
                tx_hash = await asyncio.to_thread(_send_origin_tx, w3, account, origin, data)
                log.info("[Relay] step %r sent on %s: %s", step.get("id"), origin.name, tx_hash)
                check = item.get("check") or {}
                if check.get("endpoint"):
                    check_endpoints.append(check["endpoint"])

        if not tx_hash:
            raise RuntimeError(f"Relay quote returned no executable transaction steps: {quote}")

        for endpoint in check_endpoints:
            await _wait_for_fill(session, endpoint)

    return tx_hash


def _to_int(value) -> int:
    """Relay may return numeric fields as int, decimal string, or hex string."""
    if value is None:
        return 0
    if isinstance(value, str):
        return int(value, 16) if value.startswith("0x") else int(value)
    return int(value)


def _send_origin_tx(w3: Web3, account, origin, data: dict) -> str:
    tx = {
        "from": account.address,
        "to": Web3.to_checksum_address(data["to"]),
        "data": data.get("data", "0x"),
        "value": _to_int(data.get("value")),
        "chainId": origin.chain_id,
        "nonce": w3.eth.get_transaction_count(account.address),
    }
    if origin.eip1559:
        base_fee = w3.eth.get_block("latest").get("baseFeePerGas", w3.eth.gas_price)
        priority = w3.to_wei(2, "gwei")
        tx["maxPriorityFeePerGas"] = priority
        tx["maxFeePerGas"] = base_fee * 2 + priority
    else:
        tx["gasPrice"] = w3.eth.gas_price
    tx["gas"] = int(w3.eth.estimate_gas(tx) * 1.3)

    signed = account.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)
    if receipt.status != 1:
        raise RuntimeError(f"Relay origin transaction reverted: {tx_hash.hex()}")
    return tx_hash.hex()


async def _wait_for_fill(session: aiohttp.ClientSession, endpoint: str) -> None:
    """Poll Relay's status endpoint until the cross-chain fill completes."""
    url = endpoint if endpoint.startswith("http") else f"{RELAY_API}{endpoint}"
    for _ in range(STATUS_POLL_TRIES):
        await asyncio.sleep(STATUS_POLL_SECONDS)
        try:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                status = (await resp.json()).get("status", "")
        except (aiohttp.ClientError, asyncio.TimeoutError):
            continue
        if status == "success":
            log.info("[Relay] fill confirmed")
            return
        if status in ("failure", "refund"):
            raise RuntimeError(f"Relay fill ended with status {status!r}")
    raise RuntimeError("Relay fill not confirmed in time (check relay.link/transactions)")
