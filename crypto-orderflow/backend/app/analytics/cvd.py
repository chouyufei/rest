from __future__ import annotations

from collections import deque


class CvdSeries:
    """Cumulative Volume Delta sampled at 1-second resolution."""

    def __init__(self, max_points: int = 3600) -> None:
        self.points: deque[tuple[int, float, float]] = deque(maxlen=max_points)
        self._cvd: float = 0.0
        self._bucket_ts: int = 0
        self._bucket_close: float | None = None

    def add_trade(self, ts_ms: int, price: float, qty: float, buyer_is_maker: bool) -> None:
        # buyer_is_maker == True => trade was sell-aggressor
        signed = -qty if buyer_is_maker else qty
        self._cvd += signed
        bucket = ts_ms // 1000
        self._bucket_close = price
        if bucket != self._bucket_ts:
            if self._bucket_ts != 0:
                self.points.append((self._bucket_ts, self._cvd, price))
            self._bucket_ts = bucket

    def snapshot(self) -> list[tuple[int, float, float]]:
        out = list(self.points)
        if self._bucket_ts and self._bucket_close is not None:
            out.append((self._bucket_ts, self._cvd, self._bucket_close))
        return out
