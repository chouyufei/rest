from __future__ import annotations

from collections import OrderedDict, defaultdict


class Footprint:
    """Time x Price footprint: for each (bin_ts, price_tick) accumulate buy/sell volumes."""

    def __init__(self, bin_sec: int, tick_size: float, max_bins: int = 120) -> None:
        self.bin_sec = bin_sec
        self.tick_size = tick_size
        self.max_bins = max_bins
        # bin_ts -> {price -> [buy_vol, sell_vol]}
        self.bins: OrderedDict[int, dict[float, list[float]]] = OrderedDict()

    def _bin_ts(self, ts_ms: int) -> int:
        s = ts_ms // 1000
        return s - (s % self.bin_sec)

    def _bucket_price(self, price: float) -> float:
        return round(round(price / self.tick_size) * self.tick_size, 8)

    def add_trade(self, ts_ms: int, price: float, qty: float, buyer_is_maker: bool) -> None:
        b = self._bin_ts(ts_ms)
        p = self._bucket_price(price)
        bin_map = self.bins.get(b)
        if bin_map is None:
            bin_map = defaultdict(lambda: [0.0, 0.0])
            self.bins[b] = bin_map
            while len(self.bins) > self.max_bins:
                self.bins.popitem(last=False)
        cell = bin_map[p]
        if buyer_is_maker:
            cell[1] += qty  # sell-aggressor
        else:
            cell[0] += qty  # buy-aggressor

    def snapshot(self) -> list[dict]:
        out: list[dict] = []
        for b, bin_map in self.bins.items():
            cells = [
                {"price": p, "buy": v[0], "sell": v[1]}
                for p, v in sorted(bin_map.items())
            ]
            buy_total = sum(c["buy"] for c in cells)
            sell_total = sum(c["sell"] for c in cells)
            out.append({
                "ts": b,
                "buy": buy_total,
                "sell": sell_total,
                "delta": buy_total - sell_total,
                "cells": cells,
            })
        return out
