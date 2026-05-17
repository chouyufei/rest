from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path
from typing import AsyncIterator

import duckdb

from ..config import DATA_DIR

log = logging.getLogger(__name__)


def _files(kind: str, market: str, symbol: str) -> list[str]:
    d = Path(DATA_DIR) / kind / market / symbol
    if not d.exists():
        return []
    return [str(p) for p in sorted(d.glob("*.parquet"))]


class HistoryReader:
    """Read-only Parquet queries via duckdb."""

    def __init__(self) -> None:
        self._con = duckdb.connect(database=":memory:")

    def list_dates(self, kind: str, market: str, symbol: str) -> list[str]:
        d = Path(DATA_DIR) / kind / market / symbol
        if not d.exists():
            return []
        out: set[str] = set()
        for p in d.glob("*.parquet"):
            stem = p.stem.split(".")[0]
            if len(stem) == 10 and stem[4] == "-" and stem[7] == "-":
                out.add(stem)
        return sorted(out)

    def _select(self, kind: str, market: str, symbol: str, cols: str,
                ts_from: int, ts_to: int, limit: int) -> list[tuple]:
        files = _files(kind, market, symbol)
        if not files:
            return []
        return self._con.execute(
            f"SELECT {cols} FROM read_parquet(?) WHERE ts BETWEEN ? AND ? ORDER BY ts LIMIT ?",
            [files, ts_from, ts_to, limit],
        ).fetchall()

    def range(self, market: str, symbol: str) -> dict | None:
        files = _files("trades", market, symbol)
        if not files:
            return None
        row = self._con.execute(
            "SELECT MIN(ts), MAX(ts), COUNT(*) FROM read_parquet(?)",
            [files],
        ).fetchone()
        if row is None or row[2] == 0:
            return None
        return {"trade_min": row[0], "trade_max": row[1], "trade_count": row[2]}

    def trades(self, market: str, symbol: str, ts_from: int, ts_to: int, limit: int = 10_000_000) -> list[tuple]:
        return self._select("trades", market, symbol,
                            "ts, price, qty, buyer_is_maker", ts_from, ts_to, limit)

    def snapshots(self, market: str, symbol: str, ts_from: int, ts_to: int, limit: int = 1_000_000) -> list[tuple]:
        return self._select("snapshots", market, symbol,
                            "ts, bids_p, bids_q, asks_p, asks_q, obi", ts_from, ts_to, limit)


class Replayer:
    """
    Drive trades + snapshots for a symbol back through the WS protocol
    at a chosen speed. Emits dicts shaped like the live broadcaster.
    """

    def __init__(self, reader: HistoryReader, market: str, symbol: str,
                 ts_from: int, ts_to: int, speed: float = 1.0) -> None:
        self.reader = reader
        self.market = market
        self.symbol = symbol
        self.key = f"{market}:{symbol}"
        self.ts_from = ts_from
        self.ts_to = ts_to
        self.speed = max(0.1, float(speed))

    async def stream(self) -> AsyncIterator[dict]:
        trades = self.reader.trades(self.market, self.symbol, self.ts_from, self.ts_to)
        snaps = self.reader.snapshots(self.market, self.symbol, self.ts_from, self.ts_to)

        events = self._merge(trades, snaps)
        if not events:
            return

        start_real = time.monotonic()
        start_evt = events[0][0]
        # 初始 init: 把第一帧 snapshot 作为顶部盘口
        first_snap = next((e for e in events if e[1] == "depth"), None)
        if first_snap is not None:
            ts, _, data = first_snap
            yield {
                "type": "init",
                "data": {
                    self.key: {
                        "symbol": self.symbol,
                        "market": self.market,
                        "tick_size": 0.0,         # 前端会用本地缓存的 tick_size
                        "ready": True,
                        "last_price": None,
                        "obi": float(data["obi"]),
                        "bids": list(zip(data["bids_p"], data["bids_q"])),
                        "asks": list(zip(data["asks_p"], data["asks_q"])),
                        "tape": [], "cvd": [], "footprint": [], "heatmap": [],
                    }
                }
            }

        for ts, kind, payload in events:
            elapsed = (ts - start_evt) / 1000 / self.speed
            wait = elapsed - (time.monotonic() - start_real)
            if wait > 0:
                await asyncio.sleep(wait)
            if kind == "trade":
                yield {
                    "type": "trade",
                    "key": self.key,
                    "data": {
                        "ts": ts,
                        "price": payload["price"],
                        "qty": payload["qty"],
                        "side": "sell" if payload["buyer_is_maker"] else "buy",
                    },
                }
            else:
                yield {
                    "type": "depth",
                    "key": self.key,
                    "data": {
                        "ts": ts,
                        "bids": list(zip(payload["bids_p"], payload["bids_q"])),
                        "asks": list(zip(payload["asks_p"], payload["asks_q"])),
                        "obi": float(payload["obi"]),
                    },
                }

    @staticmethod
    def _merge(trades: list[tuple], snaps: list[tuple]) -> list[tuple[int, str, dict]]:
        out: list[tuple[int, str, dict]] = []
        for ts, p, q, m in trades:
            out.append((int(ts), "trade", {"price": p, "qty": q, "buyer_is_maker": bool(m)}))
        for ts, bp, bq, ap, aq, obi in snaps:
            out.append((int(ts), "depth", {
                "bids_p": list(bp), "bids_q": list(bq),
                "asks_p": list(ap), "asks_q": list(aq),
                "obi": obi,
            }))
        out.sort(key=lambda e: e[0])
        return out
