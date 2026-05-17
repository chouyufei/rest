from __future__ import annotations

from collections import deque


class DepthHeatmap:
    """Time-series ring buffer of depth frames around best bid/ask, sampled at fixed cadence."""

    def __init__(self, levels: int, max_frames: int = 600) -> None:
        self.levels = levels
        self.frames: deque[dict] = deque(maxlen=max_frames)

    def push(self, ts_ms: int, bids: list[tuple[float, float]], asks: list[tuple[float, float]]) -> None:
        self.frames.append({
            "ts": ts_ms,
            "bids": [(round(p, 8), round(q, 8)) for p, q in bids[: self.levels]],
            "asks": [(round(p, 8), round(q, 8)) for p, q in asks[: self.levels]],
        })

    def snapshot(self) -> list[dict]:
        return list(self.frames)


def order_book_imbalance(bids: list[tuple[float, float]], asks: list[tuple[float, float]], depth: int = 10) -> float:
    bv = sum(q for _, q in bids[:depth])
    av = sum(q for _, q in asks[:depth])
    if bv + av == 0:
        return 0.0
    return (bv - av) / (bv + av)
