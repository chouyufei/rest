from __future__ import annotations

import asyncio
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq

from ..config import (
    DATA_DIR,
    PERSIST_ENABLED,
    SNAPSHOT_PERSIST_LEVELS,
    WRITER_FLUSH_ROWS,
    WRITER_FLUSH_SEC,
)

log = logging.getLogger(__name__)

TRADE_SCHEMA = pa.schema([
    pa.field("ts", pa.int64()),
    pa.field("price", pa.float64()),
    pa.field("qty", pa.float64()),
    pa.field("buyer_is_maker", pa.bool_()),
])

SNAPSHOT_SCHEMA = pa.schema([
    pa.field("ts", pa.int64()),
    pa.field("bids_p", pa.list_(pa.float64())),
    pa.field("bids_q", pa.list_(pa.float64())),
    pa.field("asks_p", pa.list_(pa.float64())),
    pa.field("asks_q", pa.list_(pa.float64())),
    pa.field("obi", pa.float32()),
])

DIFF_SCHEMA = pa.schema([
    pa.field("ts", pa.int64()),
    pa.field("U", pa.int64()),
    pa.field("u", pa.int64()),
    pa.field("pu", pa.int64()),   # -1 for spot
    pa.field("bids_p", pa.list_(pa.float64())),
    pa.field("bids_q", pa.list_(pa.float64())),
    pa.field("asks_p", pa.list_(pa.float64())),
    pa.field("asks_q", pa.list_(pa.float64())),
])


def _utc_date(ts_ms: int) -> str:
    return datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")


class _ParquetSink:
    """Buffer rows, flush each batch as its own self-contained Parquet file.

    Files are written under data/{kind}/{market}/{symbol}/{date}.{epoch_ms}.parquet
    so they're sortable by name and immediately readable by duckdb.
    """

    def __init__(self, kind: str, market: str, symbol: str, schema: pa.Schema) -> None:
        self.kind = kind
        self.market = market
        self.symbol = symbol
        self.schema = schema
        self._buf: dict[str, list[Any]] = {f.name: [] for f in schema}
        self._buf_rows = 0
        self._dir = Path(DATA_DIR) / kind / market / symbol
        self._dir.mkdir(parents=True, exist_ok=True)

    def append(self, row: dict[str, Any]) -> None:
        for k in self.schema.names:
            self._buf[k].append(row[k])
        self._buf_rows += 1

    def flush(self) -> int:
        if self._buf_rows == 0:
            return 0
        # 文件名按首行时间戳的 UTC 日期 + 当前毫秒，保证日内排序与跨日切割
        first_ts = int(self._buf["ts"][0])
        date = _utc_date(first_ts)
        path = self._dir / f"{date}.{int(time.time() * 1000)}.parquet"
        try:
            table = pa.Table.from_pydict(self._buf, schema=self.schema)
            pq.write_table(table, path, compression="zstd")
        except Exception as exc:
            log.warning("write %s err: %r", path, exc)
            return 0
        n = self._buf_rows
        self._buf = {f.name: [] for f in self.schema}
        self._buf_rows = 0
        return n

    @property
    def buffered(self) -> int:
        return self._buf_rows


class StorageHub:
    def __init__(self) -> None:
        self.enabled = PERSIST_ENABLED
        self._sinks: dict[tuple[str, str, str], _ParquetSink] = {}
        self._task: asyncio.Task | None = None
        if self.enabled:
            os.makedirs(DATA_DIR, exist_ok=True)

    def _sink(self, kind: str, market: str, symbol: str, schema: pa.Schema) -> _ParquetSink:
        key = (kind, market, symbol)
        s = self._sinks.get(key)
        if s is None:
            s = _ParquetSink(kind, market, symbol, schema)
            self._sinks[key] = s
        return s

    # ---- write paths -----------------------------------------------------

    def on_trade(self, market: str, symbol: str, ts_ms: int, price: float, qty: float, buyer_is_maker: bool) -> None:
        if not self.enabled:
            return
        s = self._sink("trades", market, symbol, TRADE_SCHEMA)
        s.append({"ts": ts_ms, "price": price, "qty": qty, "buyer_is_maker": buyer_is_maker})
        if s.buffered >= WRITER_FLUSH_ROWS:
            s.flush()

    def on_snapshot(
        self,
        market: str,
        symbol: str,
        ts_ms: int,
        bids: list[tuple[float, float]],
        asks: list[tuple[float, float]],
        obi: float,
    ) -> None:
        if not self.enabled:
            return
        s = self._sink("snapshots", market, symbol, SNAPSHOT_SCHEMA)
        b = bids[:SNAPSHOT_PERSIST_LEVELS]
        a = asks[:SNAPSHOT_PERSIST_LEVELS]
        s.append({
            "ts": ts_ms,
            "bids_p": [p for p, _ in b],
            "bids_q": [q for _, q in b],
            "asks_p": [p for p, _ in a],
            "asks_q": [q for _, q in a],
            "obi": float(obi),
        })

    def on_diff(self, market: str, symbol: str, payload: dict) -> None:
        if not self.enabled:
            return
        try:
            ts = int(payload.get("E", 0))
            U = int(payload["U"])
            u = int(payload["u"])
            pu_raw = payload.get("pu")
            pu = int(pu_raw) if pu_raw is not None else -1
            bids = payload.get("b", [])
            asks = payload.get("a", [])
        except (KeyError, ValueError, TypeError):
            return
        s = self._sink("diffs", market, symbol, DIFF_SCHEMA)
        s.append({
            "ts": ts,
            "U": U,
            "u": u,
            "pu": pu,
            "bids_p": [float(p) for p, _ in bids],
            "bids_q": [float(q) for _, q in bids],
            "asks_p": [float(p) for p, _ in asks],
            "asks_q": [float(q) for _, q in asks],
        })
        if s.buffered >= WRITER_FLUSH_ROWS:
            s.flush()

    # ---- lifecycle -------------------------------------------------------

    async def start(self) -> None:
        if not self.enabled or self._task is not None:
            return
        self._task = asyncio.create_task(self._flush_loop())

    async def _flush_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(WRITER_FLUSH_SEC)
                self._flush_all("interval")
        except asyncio.CancelledError:
            pass

    def _flush_all(self, reason: str) -> None:
        total = 0
        for s in list(self._sinks.values()):
            try:
                total += s.flush()
            except Exception as exc:
                log.warning("flush %s/%s/%s err: %r", s.kind, s.market, s.symbol, exc)
        if total:
            log.info("[%s] flushed %d rows across %d sinks", reason, total, len(self._sinks))

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        self._flush_all("shutdown")


storage = StorageHub()
