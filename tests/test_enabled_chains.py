"""Offline tests for the ENABLED_CHAINS filter."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import config
from sniper import chains
from sniper.detector import probe_targets, solana_enabled


def test_empty_means_all_chains(monkeypatch):
    monkeypatch.setattr(config, "ENABLED_CHAINS", [])
    assert probe_targets() == list(chains.EVM_PROBE_ORDER)
    assert solana_enabled()


def test_ethereum_and_solana_only(monkeypatch):
    monkeypatch.setattr(config, "ENABLED_CHAINS", ["ethereum", "solana"])
    assert probe_targets() == ["ethereum"]
    assert solana_enabled()


def test_evm_only_disables_solana(monkeypatch):
    monkeypatch.setattr(config, "ENABLED_CHAINS", ["bsc", "base"])
    assert probe_targets() == ["bsc", "base"]
    assert not solana_enabled()
