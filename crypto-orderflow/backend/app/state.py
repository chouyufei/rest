from __future__ import annotations

import asyncio
from collections import deque
from typing import Any

from .analytics import CvdSeries, DepthHeatmap, Footprint, order_book_imbalance
from .config import (
    HEATMAP_RING_FRAMES,
    SYMBOLS,
    TRADE_TAPE_SIZE,
    VISIBLE_DEPTH_LEVELS,
    SymbolSpec,
)
from .orderbook import OrderBook


class SymbolState:
    def __init__(self, spec: SymbolSpec) -> None:
        self.spec = spec
        self.key = f"{spec.market}:{spec.symbol}"
        self.book = OrderBook()
        self.cvd = CvdSeries()
        self.footprint = Footprint(spec.footprint_bin_sec, spec.tick_size)
        self.heatmap = DepthHeatmap(VISIBLE_DEPTH_LEVELS, HEATMAP_RING_FRAMES)
        self.tape: deque[dict] = deque(maxlen=TRADE_TAPE_SIZE)
        self.obi: float = 0.0
        self.last_price: float | None = None
        self.lock = asyncio.Lock()

    def on_trade(self, ts_ms: int, price: float, qty: float, buyer_is_maker: bool) -> dict:
        self.last_price = price
        self.cvd.add_trade(ts_ms, price, qty, buyer_is_maker)
        self.footprint.add_trade(ts_ms, price, qty, buyer_is_maker)
        item = {
            "ts": ts_ms,
            "price": price,
            "qty": qty,
            "side": "sell" if buyer_is_maker else "buy",
        }
        self.tape.append(item)
        return item

    def sample_depth(self, ts_ms: int) -> dict | None:
        if not self.book.ready:
            return None
        bids, asks = self.book.top_n(VISIBLE_DEPTH_LEVELS)
        self.heatmap.push(ts_ms, bids, asks)
        self.obi = order_book_imbalance(bids, asks)
        return {
            "ts": ts_ms,
            "bids": bids,
            "asks": asks,
            "obi": self.obi,
        }

    def snapshot_full(self) -> dict[str, Any]:
        bids, asks = self.book.top_n(VISIBLE_DEPTH_LEVELS) if self.book.ready else ([], [])
        return {
            "symbol": self.spec.symbol,
            "market": self.spec.market,
            "tick_size": self.spec.tick_size,
            "ready": self.book.ready,
            "last_price": self.last_price,
            "obi": self.obi,
            "bids": bids,
            "asks": asks,
            "tape": list(self.tape),
            "cvd": self.cvd.snapshot(),
            "footprint": self.footprint.snapshot(),
            "heatmap": self.heatmap.snapshot(),
        }


class Hub:
    def __init__(self) -> None:
        self.symbols: dict[str, SymbolState] = {
            f"{s.market}:{s.symbol}": SymbolState(s) for s in SYMBOLS
        }
        self.subscribers: set[asyncio.Queue] = set()

    def get(self, market: str, symbol: str) -> SymbolState | None:
        return self.symbols.get(f"{market}:{symbol.upper()}")

    async def broadcast(self, msg: dict) -> None:
        dead: list[asyncio.Queue] = []
        for q in self.subscribers:
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:
                dead.append(q)
        for q in dead:
            self.subscribers.discard(q)

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=2000)
        self.subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self.subscribers.discard(q)


hub = Hub()
