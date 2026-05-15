from __future__ import annotations

import asyncio
import logging
from collections import deque
from typing import Any

import httpx
import orjson
import websockets

from ..config import (
    DEPTH_SNAPSHOT_LIMIT_FUTURES,
    DEPTH_SNAPSHOT_LIMIT_SPOT,
    FUTURES_REST_BASE,
    FUTURES_WS_BASE,
    SPOT_REST_BASE,
    SPOT_WS_BASE,
    SymbolSpec,
)
from ..state import SymbolState, hub

log = logging.getLogger(__name__)


def _streams_for(spec: SymbolSpec) -> list[str]:
    sym = spec.symbol.lower()
    if spec.market == "spot":
        return [f"{sym}@trade", f"{sym}@depth@100ms"]
    return [f"{sym}@aggTrade", f"{sym}@depth@100ms"]


def _ws_url(spec: SymbolSpec) -> str:
    base = SPOT_WS_BASE if spec.market == "spot" else FUTURES_WS_BASE
    streams = "/".join(_streams_for(spec))
    return f"{base}?streams={streams}"


async def _fetch_snapshot(client: httpx.AsyncClient, spec: SymbolSpec) -> dict[str, Any]:
    if spec.market == "spot":
        url = f"{SPOT_REST_BASE}/api/v3/depth"
        limit = DEPTH_SNAPSHOT_LIMIT_SPOT
    else:
        url = f"{FUTURES_REST_BASE}/fapi/v1/depth"
        limit = DEPTH_SNAPSHOT_LIMIT_FUTURES
    r = await client.get(url, params={"symbol": spec.symbol, "limit": limit}, timeout=15.0)
    r.raise_for_status()
    return r.json()


def _trade_fields(payload: dict, market: str) -> tuple[int, float, float, bool]:
    # spot @trade: T, p, q, m   ; futures @aggTrade: T, p, q, m
    ts = int(payload["T"])
    price = float(payload["p"])
    qty = float(payload["q"])
    maker = bool(payload["m"])
    return ts, price, qty, maker


class SymbolStream:
    def __init__(self, state: SymbolState, http: httpx.AsyncClient) -> None:
        self.state = state
        self.http = http
        self.buffer: deque[dict] = deque()
        self.synced = False

    async def run(self) -> None:
        url = _ws_url(self.state.spec)
        while True:
            try:
                async with websockets.connect(url, ping_interval=15, ping_timeout=20, max_size=2**22) as ws:
                    log.info("WS connected %s", self.state.key)
                    self.synced = False
                    self.buffer.clear()
                    snapshot_task = asyncio.create_task(self._bootstrap_snapshot())
                    async for raw in ws:
                        msg = orjson.loads(raw)
                        data = msg.get("data") or msg
                        stream = msg.get("stream", "")
                        if "depth" in stream:
                            await self._on_depth(data)
                        elif "trade" in stream or "aggTrade" in stream:
                            self._on_trade(data)
                    snapshot_task.cancel()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning("WS %s reconnect: %r", self.state.key, exc)
                await asyncio.sleep(2.0)

    def _on_trade(self, payload: dict) -> None:
        ts, price, qty, maker = _trade_fields(payload, self.state.spec.market)
        item = self.state.on_trade(ts, price, qty, maker)
        # fire-and-forget broadcast
        asyncio.create_task(
            hub.broadcast({
                "type": "trade",
                "key": self.state.key,
                "data": item,
            })
        )

    async def _on_depth(self, payload: dict) -> None:
        if not self.state.book.ready:
            self.buffer.append(payload)
            return
        if not self.synced:
            self.buffer.append(payload)
            return
        await self._apply(payload)

    async def _apply(self, payload: dict) -> None:
        U = int(payload["U"])
        u = int(payload["u"])
        if self.state.spec.market == "spot":
            if u <= self.state.book.last_update_id:
                return
            if U > self.state.book.last_update_id + 1:
                log.warning("%s gap U=%d last=%d -> resync", self.state.key, U, self.state.book.last_update_id)
                self.state.book.ready = False
                self.synced = False
                self.buffer.clear()
                asyncio.create_task(self._bootstrap_snapshot())
                return
        else:
            pu = int(payload.get("pu", -1))
            if pu != -1 and pu != self.state.book.last_update_id:
                log.warning("%s pu mismatch pu=%d last=%d -> resync", self.state.key, pu, self.state.book.last_update_id)
                self.state.book.ready = False
                self.synced = False
                self.buffer.clear()
                asyncio.create_task(self._bootstrap_snapshot())
                return
        self.state.book.apply_diff(payload.get("b", []), payload.get("a", []))
        self.state.book.last_update_id = u

    async def _bootstrap_snapshot(self) -> None:
        # let buffer fill briefly so we don't fetch before events arrive
        await asyncio.sleep(1.0)
        try:
            snap = await _fetch_snapshot(self.http, self.state.spec)
        except Exception as exc:
            log.error("snapshot fail %s: %s", self.state.key, exc)
            return
        last_id = int(snap["lastUpdateId"])
        self.state.book.load_snapshot(snap.get("bids", []), snap.get("asks", []), last_id)
        # drop stale events then process
        pending = list(self.buffer)
        self.buffer.clear()
        for ev in pending:
            U = int(ev["U"])
            u = int(ev["u"])
            if self.state.spec.market == "spot":
                if u <= last_id:
                    continue
                if U <= last_id + 1 <= u:
                    self.state.book.apply_diff(ev.get("b", []), ev.get("a", []))
                    self.state.book.last_update_id = u
                else:
                    self.state.book.apply_diff(ev.get("b", []), ev.get("a", []))
                    self.state.book.last_update_id = u
            else:
                if u < last_id:
                    continue
                if U <= last_id <= u or int(ev.get("pu", -1)) == self.state.book.last_update_id:
                    self.state.book.apply_diff(ev.get("b", []), ev.get("a", []))
                    self.state.book.last_update_id = u
        self.synced = True
        log.info("synced %s @ %d (%d bids, %d asks)",
                 self.state.key, last_id, len(self.state.book.bids), len(self.state.book.asks))


async def run_all(specs: list[SymbolSpec]) -> None:
    async with httpx.AsyncClient() as http:
        streams = [SymbolStream(hub.symbols[f"{s.market}:{s.symbol}"], http) for s in specs]
        tasks = [asyncio.create_task(s.run()) for s in streams]
        sampler = asyncio.create_task(_depth_sampler(streams))
        try:
            await asyncio.gather(*tasks, sampler)
        except asyncio.CancelledError:
            for t in tasks + [sampler]:
                t.cancel()
            raise


async def _depth_sampler(streams: list[SymbolStream]) -> None:
    import time

    while True:
        await asyncio.sleep(1.0)
        ts = int(time.time() * 1000)
        for s in streams:
            sample = s.state.sample_depth(ts)
            if sample is None:
                continue
            await hub.broadcast({
                "type": "depth",
                "key": s.state.key,
                "data": {
                    "ts": ts,
                    "bids": sample["bids"],
                    "asks": sample["asks"],
                    "obi": sample["obi"],
                },
            })
