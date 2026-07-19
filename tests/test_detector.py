"""Offline tests for address extraction (no network calls)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sniper.detector import extract_candidates


def test_extracts_evm_address():
    text = "New gem! CA: 0x6982508145454Ce325dDbE47a25d4ec3d2311933 100x soon"
    evm, sol = extract_candidates(text)
    assert evm == ["0x6982508145454Ce325dDbE47a25d4ec3d2311933"]
    assert sol == []


def test_extracts_solana_mint():
    text = "ape this: DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"
    evm, sol = extract_candidates(text)
    assert evm == []
    assert sol == ["DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"]


def test_ignores_wrapped_sol_and_stables():
    text = "pair vs So11111111111111111111111111111111111111112 and EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    evm, sol = extract_candidates(text)
    assert evm == [] and sol == []


def test_ignores_random_words_and_short_hex():
    text = "just chatting about 0x1234 and BullishAF today, no contracts here"
    evm, sol = extract_candidates(text)
    assert evm == [] and sol == []


def test_dedupes_repeated_address():
    addr = "0x6982508145454Ce325dDbE47a25d4ec3d2311933"
    evm, _ = extract_candidates(f"{addr} again {addr}")
    assert evm == [addr]


def test_multiple_addresses_in_one_message():
    text = (
        "ETH: 0x6982508145454Ce325dDbE47a25d4ec3d2311933 "
        "SOL: DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"
    )
    evm, sol = extract_candidates(text)
    assert len(evm) == 1 and len(sol) == 1
