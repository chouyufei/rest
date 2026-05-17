from __future__ import annotations

from collections import deque
from typing import Literal

SignalKind = Literal["absorption", "iceberg"]


class TradeWindow:
    """Sliding time window of (ts, price, qty, buyer_is_maker)."""

    def __init__(self, window_ms: int = 30_000) -> None:
        self.window_ms = window_ms
        self._buf: deque[tuple[int, float, float, bool]] = deque()

    def add(self, ts: int, price: float, qty: float, buyer_is_maker: bool) -> None:
        self._buf.append((ts, price, qty, buyer_is_maker))
        cutoff = ts - self.window_ms
        while self._buf and self._buf[0][0] < cutoff:
            self._buf.popleft()

    def items(self) -> list[tuple[int, float, float, bool]]:
        return list(self._buf)


class SignalDetector:
    """
    Absorption:
      在 ABS_WINDOW_MS 内同一价位累积成交量 >= ABS_VOL_MULT × 该窗口中位单笔量，
      且该窗口内价格区间 / 中价 <= ABS_PRICE_FRAC，视为吸筹（大单接盘/挂盘）。

    Iceberg:
      连续 N 次以上以同一价位为对手方的成交，且对应一侧的 best 价位多次被
      “补满”（即 best 还在原价附近，没明显走开），视为冰山单。
      简化版：同一价位 ICE_REPEAT 笔成交累积量 >= ICE_VOL_MULT × top-of-book avg。
    """

    ABS_WINDOW_MS = 15_000
    ABS_PRICE_FRAC = 0.0005     # 0.05%
    ABS_VOL_MULT = 8.0          # 累积量需达到窗口中位单笔的 N 倍
    ABS_MIN_BOOK_MULT = 5.0     # 同时必须 >= top-of-book 平均量的 N 倍
    ABS_COOLDOWN_MS = 5_000

    ICE_WINDOW_MS = 60_000
    ICE_REPEAT = 6
    ICE_VOL_MULT = 3.0
    ICE_MIN_BOOK_MULT = 2.0     # 兜底：必须超过 top-of-book 平均 N 倍
    ICE_COOLDOWN_MS = 10_000

    def __init__(self) -> None:
        self.window = TradeWindow(60_000)
        # 各价位上次冷却时间
        self._last_emit_abs: dict[float, int] = {}
        self._last_emit_ice: dict[float, int] = {}
        # 价位 -> deque[(ts, qty, side)]
        self._by_price: dict[float, deque[tuple[int, float, bool]]] = {}

    def on_trade(self, ts: int, price: float, qty: float, buyer_is_maker: bool,
                 best_top_avg_qty: float) -> list[dict]:
        self.window.add(ts, price, qty, buyer_is_maker)
        out: list[dict] = []

        # update per-price buffer
        d = self._by_price.setdefault(price, deque())
        d.append((ts, qty, buyer_is_maker))
        cutoff = ts - self.ICE_WINDOW_MS
        while d and d[0][0] < cutoff:
            d.popleft()
        # 清理空 price buckets，避免内存膨胀
        if not d:
            self._by_price.pop(price, None)

        sig = self._check_absorption(ts, price, best_top_avg_qty)
        if sig:
            out.append(sig)
        sig = self._check_iceberg(ts, price, best_top_avg_qty)
        if sig:
            out.append(sig)

        # 周期性清理
        if ts % 60_000 < 1000:
            self._cleanup_price_buckets(ts)

        return out

    def _check_absorption(self, ts: int, price: float, best_top_avg_qty: float) -> dict | None:
        last = self._last_emit_abs.get(price, 0)
        if ts - last < self.ABS_COOLDOWN_MS:
            return None
        # 窗口内同价成交累积
        win_ms = self.ABS_WINDOW_MS
        items = [(t, p, q, m) for t, p, q, m in self.window.items()
                 if t >= ts - win_ms and p == price]
        if len(items) < 3:
            return None
        vols = [q for _, _, q, _ in items]
        cum = sum(vols)
        median = sorted(vols)[len(vols) // 2]
        if median <= 0:
            return None
        if cum < self.ABS_VOL_MULT * median:
            return None
        # 兜底：必须明显超过盘口平均量，过滤极小单噪声
        if best_top_avg_qty > 0 and cum < self.ABS_MIN_BOOK_MULT * best_top_avg_qty:
            return None
        # 价格稳定性：窗口内所有 trade 的价格区间相对中价
        all_in_win = [t for t in self.window.items() if t[0] >= ts - win_ms]
        if not all_in_win:
            return None
        prices = [p for _, p, _, _ in all_in_win]
        lo, hi = min(prices), max(prices)
        mid = (lo + hi) / 2 if lo != hi else lo
        if mid <= 0:
            return None
        if (hi - lo) / mid > self.ABS_PRICE_FRAC:
            return None
        sells = sum(q for _, _, q, m in items if m)
        buys = sum(q for _, _, q, m in items if not m)
        side = "bid" if sells > buys else "ask"
        # bid absorption = 大量主动卖被买盘吃下 (price 没跌)
        # ask absorption = 大量主动买被卖盘挡住 (price 没涨)
        self._last_emit_abs[price] = ts
        return {
            "kind": "absorption",
            "ts": ts,
            "price": price,
            "qty": cum,
            "side": side,
            "note": f"{cum:.4f} in {win_ms}ms",
        }

    def _check_iceberg(self, ts: int, price: float, best_top_avg_qty: float) -> dict | None:
        last = self._last_emit_ice.get(price, 0)
        if ts - last < self.ICE_COOLDOWN_MS:
            return None
        d = self._by_price.get(price)
        if not d or len(d) < self.ICE_REPEAT:
            return None
        cum = sum(q for _, q, _ in d)
        if best_top_avg_qty > 0 and cum < self.ICE_VOL_MULT * best_top_avg_qty:
            return None
        sells = sum(q for _, q, m in d if m)
        buys = sum(q for _, q, m in d if not m)
        # iceberg 在哪一侧：被反复吃 = 那一侧有隐藏挂单
        side = "bid" if sells > buys else "ask"
        self._last_emit_ice[price] = ts
        return {
            "kind": "iceberg",
            "ts": ts,
            "price": price,
            "qty": cum,
            "side": side,
            "note": f"{len(d)} prints in {self.ICE_WINDOW_MS}ms",
        }

    def _cleanup_price_buckets(self, ts: int) -> None:
        cutoff = ts - self.ICE_WINDOW_MS
        for p in list(self._by_price.keys()):
            d = self._by_price[p]
            while d and d[0][0] < cutoff:
                d.popleft()
            if not d:
                self._by_price.pop(p, None)
