from __future__ import annotations

from sortedcontainers import SortedDict


class OrderBook:
    """In-memory L2 book. Bids descending by price, asks ascending."""

    def __init__(self) -> None:
        self.bids: SortedDict[float, float] = SortedDict(lambda p: -p)
        self.asks: SortedDict[float, float] = SortedDict()
        self.last_update_id: int = 0
        self.ready: bool = False

    def load_snapshot(self, bids: list[list[str]], asks: list[list[str]], last_update_id: int) -> None:
        self.bids.clear()
        self.asks.clear()
        for p, q in bids:
            qf = float(q)
            if qf > 0:
                self.bids[float(p)] = qf
        for p, q in asks:
            qf = float(q)
            if qf > 0:
                self.asks[float(p)] = qf
        self.last_update_id = last_update_id
        self.ready = True

    def apply_diff(self, bids: list[list[str]], asks: list[list[str]]) -> None:
        for p, q in bids:
            pf, qf = float(p), float(q)
            if qf == 0:
                self.bids.pop(pf, None)
            else:
                self.bids[pf] = qf
        for p, q in asks:
            pf, qf = float(p), float(q)
            if qf == 0:
                self.asks.pop(pf, None)
            else:
                self.asks[pf] = qf

    def best_bid(self) -> float | None:
        if not self.bids:
            return None
        return next(iter(self.bids))

    def best_ask(self) -> float | None:
        if not self.asks:
            return None
        return next(iter(self.asks))

    def mid(self) -> float | None:
        bb, ba = self.best_bid(), self.best_ask()
        if bb is None or ba is None:
            return None
        return (bb + ba) / 2

    def top_n(self, n: int) -> tuple[list[tuple[float, float]], list[tuple[float, float]]]:
        bids = [(p, self.bids[p]) for p in list(self.bids.keys())[:n]]
        asks = [(p, self.asks[p]) for p in list(self.asks.keys())[:n]]
        return bids, asks
