"""Offline tests for Relay quote construction (no network calls)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from sniper.relay_buyer import (
    NATIVE_EVM,
    RELAY_SOLANA_CHAIN_ID,
    _to_int,
    build_quote_body,
    destination_chain_id,
)

USER = "0x000000000000000000000000000000000000dEaD"
PEPE = "0x6982508145454Ce325dDbE47a25d4ec3d2311933"
BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"


def test_destination_chain_ids():
    assert destination_chain_id("ethereum") == 1
    assert destination_chain_id("base") == 8453
    assert destination_chain_id("solana") == RELAY_SOLANA_CHAIN_ID
    assert destination_chain_id("unknown-chain") is None


def test_quote_body_evm_destination():
    body = build_quote_body(USER, "ethereum", PEPE, 10**16)
    assert body["user"] == body["recipient"] == USER
    assert body["originChainId"] == 8453  # default origin: base
    assert body["destinationChainId"] == 1
    assert body["originCurrency"] == NATIVE_EVM
    assert body["destinationCurrency"] == PEPE
    assert body["amount"] == str(10**16)
    assert body["tradeType"] == "EXACT_INPUT"


def test_quote_body_solana_destination(monkeypatch):
    import config

    monkeypatch.setattr(config, "SOLANA_RECIPIENT", BONK)  # any valid pubkey string
    body = build_quote_body(USER, "solana", BONK, 10**16)
    assert body["destinationChainId"] == RELAY_SOLANA_CHAIN_ID
    assert body["recipient"] == BONK


def test_quote_body_solana_without_recipient_fails(monkeypatch):
    import config

    monkeypatch.setattr(config, "SOLANA_RECIPIENT", "")
    monkeypatch.setattr(config, "SOLANA_PRIVATE_KEY", "")
    with pytest.raises(RuntimeError, match="SOLANA_RECIPIENT"):
        build_quote_body(USER, "solana", BONK, 10**16)


def test_to_int_accepts_relay_number_formats():
    assert _to_int(None) == 0
    assert _to_int(5) == 5
    assert _to_int("5") == 5
    assert _to_int("0x10") == 16
