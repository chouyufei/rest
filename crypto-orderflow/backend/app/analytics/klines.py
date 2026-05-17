from __future__ import annotations

import logging
from pathlib import Path
from typing import Iterable

import duckdb
import httpx

from ..config import (
    DATA_DIR,
    FUTURES_REST_BASE,
    SPOT_REST_BASE,
)

log = logging.getLogger(__name__)

INTERVAL_MS: dict[str, int] = {
    "1s": 1_000,
    "1m": 60_000,
    "5m": 5 * 60_000,
    "15m": 15 * 60_000,
    "1h": 60 * 60_000,
    "4h": 4 * 60 * 60_000,
    "1d": 24 * 60 * 60_000,
    "3d": 3 * 24 * 60 * 60_000,
    "1w": 7 * 24 * 60 * 60_000,
}

BINANCE_INTERVAL: dict[str, str] = {
    "1s": "1s",
    "1m": "1m",
    "5m": "5m",
    "15m": "15m",
    "1h": "1h",
    "4h": "4h",
    "1d": "1d",
    "3d": "3d",
    "1w": "1w",
}


def supported_intervals() -> list[str]:
    return list(INTERVAL_MS.keys())


def _trade_files(market: str, symbol: str) -> list[str]:
    d = Path(DATA_DIR) / "trades" / market / symbol
    if not d.exists():
        return []
    return [str(p) for p in sorted(d.glob("*.parquet"))]


_conn: duckdb.DuckDBPyConnection | None = None


def _con() -> duckdb.DuckDBPyConnection:
    global _conn
    if _conn is None:
        _conn = duckdb.connect(":memory:")
    return _conn


def aggregate_local(
    market: str, symbol: str, interval: str,
    ts_from: int | None = None, ts_to: int | None = None, limit: int = 1500,
) -> list[dict]:
    """从本地 trades.parquet 聚合 OHLCV。"""
    ms = INTERVAL_MS.get(interval)
    if ms is None:
        raise ValueError(f"unsupported interval {interval}")
    files = _trade_files(market, symbol)
    if not files:
        return []
    cond_parts: list[str] = []
    params: list = [files, ms]
    if ts_from is not None:
        cond_parts.append("ts >= ?")
        params.append(ts_from)
    if ts_to is not None:
        cond_parts.append("ts <= ?")
        params.append(ts_to)
    cond = (" AND " + " AND ".join(cond_parts)) if cond_parts else ""
    sql = f"""
      WITH t AS (
        SELECT ts, price, qty, buyer_is_maker,
               CAST(FLOOR(ts / ?) * ? AS BIGINT) AS bin_ts
        FROM read_parquet(?) WHERE 1=1 {cond}
      )
      SELECT
        bin_ts,
        arg_min(price, ts) AS o,
        MAX(price) AS h,
        MIN(price) AS l,
        arg_max(price, ts) AS c,
        SUM(qty) AS v,
        SUM(CASE WHEN buyer_is_maker = FALSE THEN qty ELSE 0 END) AS taker_buy_v
      FROM t
      GROUP BY bin_ts
      ORDER BY bin_ts DESC
      LIMIT ?
    """
    # params order: ms, ms, files, [conditions...], limit
    bind = [ms, ms, files] + params[2:] + [limit]
    rows = _con().execute(sql, bind).fetchall()
    rows.reverse()
    return [
        {"ts": int(r[0]), "o": float(r[1]), "h": float(r[2]), "l": float(r[3]),
         "c": float(r[4]), "v": float(r[5]), "taker_buy_v": float(r[6])}
        for r in rows
    ]


async def fetch_binance_klines(
    market: str, symbol: str, interval: str, limit: int = 500,
) -> list[dict]:
    """从币安 REST 拉历史 K 线。"""
    bi = BINANCE_INTERVAL.get(interval)
    if bi is None:
        raise ValueError(f"unsupported interval {interval}")
    if market == "spot":
        url = f"{SPOT_REST_BASE}/api/v3/klines"
    else:
        url = f"{FUTURES_REST_BASE}/fapi/v1/klines"
    params = {"symbol": symbol.upper(), "interval": bi, "limit": min(int(limit), 1500)}
    async with httpx.AsyncClient(timeout=15.0) as c:
        r = await c.get(url, params=params)
        r.raise_for_status()
        data = r.json()
    out: list[dict] = []
    for row in data:
        # row[0]=openTime, 1=O, 2=H, 3=L, 4=C, 5=volume, 9=takerBuyBaseVolume
        out.append({
            "ts": int(row[0]),
            "o": float(row[1]),
            "h": float(row[2]),
            "l": float(row[3]),
            "c": float(row[4]),
            "v": float(row[5]),
            "taker_buy_v": float(row[9]),
        })
    return out
