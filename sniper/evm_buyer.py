"""Buy a token on an EVM chain via a UniswapV2-compatible router.

Uses swapExactETHForTokensSupportingFeeOnTransferTokens so buys still
succeed on tokens that take a transfer tax.
"""
import logging

from web3 import Web3

import config
from sniper.chains import EvmChain

log = logging.getLogger("evm_buyer")

ROUTER_ABI = [
    {
        "name": "swapExactETHForTokensSupportingFeeOnTransferTokens",
        "type": "function",
        "stateMutability": "payable",
        "inputs": [
            {"name": "amountOutMin", "type": "uint256"},
            {"name": "path", "type": "address[]"},
            {"name": "to", "type": "address"},
            {"name": "deadline", "type": "uint256"},
        ],
        "outputs": [],
    },
    {
        "name": "getAmountsOut",
        "type": "function",
        "stateMutability": "view",
        "inputs": [
            {"name": "amountIn", "type": "uint256"},
            {"name": "path", "type": "address[]"},
        ],
        "outputs": [{"name": "amounts", "type": "uint256[]"}],
    },
]


def buy(chain: EvmChain, token_address: str, amount_native: float) -> str:
    """Swap `amount_native` of the chain's native coin for `token_address`.

    Returns the transaction hash. Raises on failure.
    """
    if not config.EVM_PRIVATE_KEY:
        raise RuntimeError("EVM_PRIVATE_KEY is not set")

    w3 = Web3(Web3.HTTPProvider(chain.rpc, request_kwargs={"timeout": 15}))
    if not w3.is_connected():
        raise RuntimeError(f"cannot reach RPC for {chain.name}: {chain.rpc}")

    account = w3.eth.account.from_key(config.EVM_PRIVATE_KEY)
    router = w3.eth.contract(address=Web3.to_checksum_address(chain.router), abi=ROUTER_ABI)
    token = Web3.to_checksum_address(token_address)
    path = [Web3.to_checksum_address(chain.wrapped_native), token]
    amount_in = w3.to_wei(amount_native, "ether")

    balance = w3.eth.get_balance(account.address)
    if balance < amount_in:
        raise RuntimeError(
            f"insufficient {chain.native_symbol}: have {w3.from_wei(balance, 'ether')}, "
            f"need {amount_native} plus gas"
        )

    amounts_out = router.functions.getAmountsOut(amount_in, path).call()
    amount_out_min = amounts_out[-1] * (10_000 - config.SLIPPAGE_BPS) // 10_000

    deadline = w3.eth.get_block("latest")["timestamp"] + 120
    tx_params = {
        "from": account.address,
        "value": amount_in,
        "nonce": w3.eth.get_transaction_count(account.address),
        "chainId": chain.chain_id,
    }
    if chain.eip1559:
        base_fee = w3.eth.get_block("latest").get("baseFeePerGas", w3.eth.gas_price)
        priority = w3.to_wei(2, "gwei")
        tx_params["maxPriorityFeePerGas"] = priority
        tx_params["maxFeePerGas"] = base_fee * 2 + priority
    else:
        tx_params["gasPrice"] = w3.eth.gas_price

    tx = router.functions.swapExactETHForTokensSupportingFeeOnTransferTokens(
        amount_out_min, path, account.address, deadline
    ).build_transaction(tx_params)
    tx["gas"] = int(w3.eth.estimate_gas(tx) * 1.3)

    signed = account.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    log.info("[%s] buy sent: %s", chain.name, tx_hash.hex())

    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)
    if receipt.status != 1:
        raise RuntimeError(f"swap transaction reverted: {tx_hash.hex()}")
    return tx_hash.hex()
