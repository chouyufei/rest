from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal

Market = Literal["spot", "futures"]


@dataclass(frozen=True)
class SymbolSpec:
    market: Market
    symbol: str
    tick_size: float
    footprint_bin_sec: int = 60


def _parse_symbols(env_val: str | None) -> list[SymbolSpec] | None:
    if not env_val:
        return None
    out: list[SymbolSpec] = []
    for tok in env_val.split(","):
        tok = tok.strip()
        if not tok:
            continue
        parts = tok.split(":")
        if len(parts) < 3:
            continue
        market = parts[0]
        symbol = parts[1].upper()
        tick = float(parts[2])
        out.append(SymbolSpec(market, symbol, tick))  # type: ignore[arg-type]
    return out or None


SYMBOLS: list[SymbolSpec] = _parse_symbols(os.environ.get("ORDERFLOW_SYMBOLS")) or [
    SymbolSpec("spot", "BTCUSDT", tick_size=1.0),
    SymbolSpec("spot", "ETHUSDT", tick_size=0.1),
    SymbolSpec("futures", "BTCUSDT", tick_size=1.0),
    SymbolSpec("futures", "ETHUSDT", tick_size=0.1),
]

# Defaults work from anywhere Binance is reachable. If your network can't reach
# api.binance.com you can switch the spot REST/WS to the public-data mirror:
#   BINANCE_SPOT_REST=https://data-api.binance.vision
#   BINANCE_SPOT_WS=wss://data-stream.binance.vision/stream
SPOT_WS_BASE = os.environ.get("BINANCE_SPOT_WS", "wss://stream.binance.com:9443/stream")
FUTURES_WS_BASE = os.environ.get("BINANCE_FUTURES_WS", "wss://fstream.binance.com/stream")
SPOT_REST_BASE = os.environ.get("BINANCE_SPOT_REST", "https://api.binance.com")
FUTURES_REST_BASE = os.environ.get("BINANCE_FUTURES_REST", "https://fapi.binance.com")

DEPTH_SNAPSHOT_LIMIT_SPOT = 5000
DEPTH_SNAPSHOT_LIMIT_FUTURES = 1000

VISIBLE_DEPTH_LEVELS = 60
HEATMAP_RING_FRAMES = 600
TRADE_TAPE_SIZE = 500

# 持久化
DATA_DIR = os.environ.get("ORDERFLOW_DATA_DIR", "data")
PERSIST_ENABLED = os.environ.get("ORDERFLOW_PERSIST", "1") not in {"0", "false", "False"}
WRITER_FLUSH_SEC = int(os.environ.get("ORDERFLOW_FLUSH_SEC", "30"))
WRITER_FLUSH_ROWS = int(os.environ.get("ORDERFLOW_FLUSH_ROWS", "5000"))
SNAPSHOT_PERSIST_LEVELS = int(os.environ.get("ORDERFLOW_PERSIST_LEVELS", "60"))
