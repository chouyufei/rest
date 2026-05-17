from __future__ import annotations

import asyncio
import logging
from typing import Iterable

import httpx

from ..config import FUTURES_REST_BASE, SymbolSpec
from ..state import hub

log = logging.getLogger(__name__)

POLL_SEC = 30


async def _fetch_one(client: httpx.AsyncClient, symbol: str) -> dict | None:
    try:
        r = await client.get(f"{FUTURES_REST_BASE}/fapi/v1/premiumIndex",
                              params={"symbol": symbol}, timeout=10.0)
        r.raise_for_status()
        d = r.json()
        return {
            "symbol": d["symbol"],
            "mark_price": float(d["markPrice"]),
            "index_price": float(d.get("indexPrice", 0) or 0),
            "funding_rate": float(d.get("lastFundingRate", 0) or 0),
            "next_funding_time": int(d.get("nextFundingTime", 0) or 0),
            "ts": int(d.get("time", 0) or 0),
        }
    except Exception as exc:
        log.warning("funding %s err: %r", symbol, exc)
        return None


async def run_funding_loop(specs: Iterable[SymbolSpec]) -> None:
    fut_syms = [s.symbol for s in specs if s.market == "futures"]
    if not fut_syms:
        return
    async with httpx.AsyncClient() as client:
        while True:
            for sym in fut_syms:
                data = await _fetch_one(client, sym)
                if data is None:
                    continue
                key = f"futures:{sym}"
                state = hub.symbols.get(key)
                if state is not None:
                    state.funding = data
                await hub.broadcast({"type": "funding", "key": key, "data": data})
            await asyncio.sleep(POLL_SEC)
