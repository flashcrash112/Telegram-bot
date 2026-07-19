"""Per-chain configuration for the EVM chains we can trade on.

Keys match DexScreener's `chainId` values so detection results map
straight onto a config. All routers are UniswapV2-compatible, so one
ABI covers every chain.
"""
from dataclasses import dataclass

import config


@dataclass(frozen=True)
class EvmChain:
    key: str            # dexscreener chainId
    name: str
    chain_id: int       # EVM network id
    default_rpc: str
    router: str         # UniswapV2-style router
    wrapped_native: str
    native_symbol: str
    eip1559: bool = True

    @property
    def rpc(self) -> str:
        return config.rpc_url(self.key, self.default_rpc)


EVM_CHAINS: dict[str, EvmChain] = {
    c.key: c
    for c in [
        EvmChain(
            key="ethereum", name="Ethereum", chain_id=1,
            default_rpc="https://eth.llamarpc.com",
            router="0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",  # Uniswap V2
            wrapped_native="0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            native_symbol="ETH",
        ),
        EvmChain(
            key="bsc", name="BNB Chain", chain_id=56,
            default_rpc="https://bsc-dataseed.binance.org",
            router="0x10ED43C718714eb63d5aA57B78B54704E256024E",  # PancakeSwap V2
            wrapped_native="0xbb4CdB9CBd36B01bD1cBaEF60aF814a3f6F0Ee75",
            native_symbol="BNB",
            eip1559=False,
        ),
        EvmChain(
            key="base", name="Base", chain_id=8453,
            default_rpc="https://mainnet.base.org",
            router="0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",  # Uniswap V2
            wrapped_native="0x4200000000000000000000000000000000000006",
            native_symbol="ETH",
        ),
        EvmChain(
            key="arbitrum", name="Arbitrum", chain_id=42161,
            default_rpc="https://arb1.arbitrum.io/rpc",
            router="0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",  # SushiSwap
            wrapped_native="0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
            native_symbol="ETH",
        ),
        EvmChain(
            key="polygon", name="Polygon", chain_id=137,
            default_rpc="https://polygon-rpc.com",
            router="0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",  # QuickSwap
            wrapped_native="0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
            native_symbol="POL",
        ),
        EvmChain(
            key="avalanche", name="Avalanche", chain_id=43114,
            default_rpc="https://api.avax.network/ext/bc/C/rpc",
            router="0x60aE616a2155Ee3d9A68541Ba4544862310933d4",  # Trader Joe
            wrapped_native="0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
            native_symbol="AVAX",
        ),
    ]
}

SOLANA_KEY = "solana"
SOLANA_DEFAULT_RPC = "https://api.mainnet-beta.solana.com"

# Order used when probing RPCs for bytecode to resolve an EVM address
# whose chain DexScreener doesn't know.
EVM_PROBE_ORDER = ["ethereum", "bsc", "base", "arbitrum", "polygon", "avalanche"]
