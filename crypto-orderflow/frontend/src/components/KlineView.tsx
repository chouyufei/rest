import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";
import { INTERVALS, type Interval, applyTradeToKlines, intervalMs, type Kline } from "../lib/klines";
import type { SymbolSnapshot } from "../lib/types";

interface Props {
  snap: SymbolSnapshot;
  inReplay: boolean;
}

type Source = "binance" | "local";

export default function KlineView({ snap, inReplay }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);

  const [interval, setInterval_] = useState<Interval>("1m");
  const [source, setSource] = useState<Source>(inReplay ? "local" : "binance");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const klinesRef = useRef<Kline[]>([]);

  // 切回放则强制本地
  useEffect(() => {
    if (inReplay && source !== "local") setSource("local");
  }, [inReplay, source]);

  // init chart once
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#0c0f14" }, textColor: "#7a8696" },
      grid: { vertLines: { color: "#1e2530" }, horzLines: { color: "#1e2530" } },
      rightPriceScale: { borderColor: "#1e2530", scaleMargins: { top: 0.05, bottom: 0.25 } },
      timeScale: { borderColor: "#1e2530", timeVisible: true, secondsVisible: true, rightOffset: 5 },
      crosshair: { mode: CrosshairMode.Normal,
                   vertLine: { style: LineStyle.Dotted, color: "#3a4757" },
                   horzLine: { style: LineStyle.Dotted, color: "#3a4757" } },
      autoSize: true,
    });
    const candle = chart.addCandlestickSeries({
      upColor: "#1fbf75", downColor: "#ef4444",
      wickUpColor: "#1fbf75", wickDownColor: "#ef4444",
      borderVisible: false,
    });
    const vol = chart.addHistogramSeries({
      priceScaleId: "vol",
      priceFormat: { type: "volume" },
      color: "#3a4757",
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    chartRef.current = chart;
    candleRef.current = candle;
    volRef.current = vol;
    return () => chart.remove();
  }, []);

  // fetch on symbol / market / interval / source change
  useEffect(() => {
    if (!candleRef.current) return;
    const ms = intervalMs(interval);
    if (ms === null) {
      // tick mode: build from tape
      klinesRef.current = snap.tape
        .slice()
        .reverse()
        .map((t) => ({ ts: t.ts, o: t.price, h: t.price, l: t.price, c: t.price,
                       v: t.qty, taker_buy_v: t.side === "buy" ? t.qty : 0 }));
      pushToChart();
      return;
    }
    let cancelled = false;
    setLoading(true); setError(null);
    const path = source === "binance"
      ? `/api/klines/binance/${snap.market}/${snap.symbol}?interval=${interval}&limit=500`
      : `/api/klines/local/${snap.market}/${snap.symbol}?interval=${interval}&limit=1500`;
    fetch(path)
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((d) => {
        if (cancelled) return;
        klinesRef.current = d.klines ?? [];
        pushToChart();
      })
      .catch((e) => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.market, snap.symbol, interval, source]);

  // incrementally fold the live tape's newest trades into the current bar
  useEffect(() => {
    const ms = intervalMs(interval);
    if (ms === null) {
      // tick mode: replace with whole tape
      klinesRef.current = snap.tape
        .slice()
        .reverse()
        .map((t) => ({ ts: t.ts, o: t.price, h: t.price, l: t.price, c: t.price,
                       v: t.qty, taker_buy_v: t.side === "buy" ? t.qty : 0 }));
      pushToChart();
      return;
    }
    const latest = snap.tape[0];
    if (!latest) return;
    const arr = klinesRef.current.slice();
    applyTradeToKlines(arr, latest, ms);
    klinesRef.current = arr;
    updateLastToChart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.tape]);

  function pushToChart() {
    const candle = candleRef.current;
    const vol = volRef.current;
    if (!candle || !vol) return;
    const data = klinesRef.current;
    const cd = data.map((k) => ({ time: (k.ts / 1000) as Time, open: k.o, high: k.h, low: k.l, close: k.c }));
    const vd = data.map((k) => ({
      time: (k.ts / 1000) as Time,
      value: k.v,
      color: k.c >= k.o ? "rgba(31,191,117,0.5)" : "rgba(239,68,68,0.5)",
    }));
    // dedupe time keys (lightweight-charts requires strictly increasing time)
    const seen = new Set<number>();
    const ucd = cd.filter((x) => (seen.has(x.time as number) ? false : (seen.add(x.time as number), true)));
    const seen2 = new Set<number>();
    const uvd = vd.filter((x) => (seen2.has(x.time as number) ? false : (seen2.add(x.time as number), true)));
    candle.setData(ucd);
    vol.setData(uvd);
    // signal markers
    const markers: SeriesMarker<Time>[] = snap.signals.slice(-50).map((s) => ({
      time: (Math.floor(s.ts / 1000)) as Time,
      position: s.side === "bid" ? "belowBar" : "aboveBar",
      shape: s.kind === "absorption" ? "circle" : "square",
      color: s.kind === "absorption" ? "#f59e0b" : "#22d3ee",
      text: `${s.kind === "absorption" ? "A" : "I"}·${s.qty.toFixed(2)}`,
    }));
    candle.setMarkers(markers);
  }

  function updateLastToChart() {
    const candle = candleRef.current;
    const vol = volRef.current;
    const data = klinesRef.current;
    if (!candle || !vol || data.length === 0) return;
    const k = data[data.length - 1];
    candle.update({ time: (k.ts / 1000) as Time, open: k.o, high: k.h, low: k.l, close: k.c });
    vol.update({ time: (k.ts / 1000) as Time, value: k.v,
                 color: k.c >= k.o ? "rgba(31,191,117,0.5)" : "rgba(239,68,68,0.5)" });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ display: "flex", gap: 4, padding: "4px 8px",
                    borderBottom: "1px solid var(--grid)", background: "#13202c",
                    flexWrap: "wrap", alignItems: "center", fontSize: 11 }}>
        {INTERVALS.map((it) => (
          <button
            key={it.id}
            onClick={() => setInterval_(it.id)}
            style={{
              ...btn,
              color: interval === it.id ? "#f59e0b" : "var(--fg-dim)",
              borderColor: interval === it.id ? "#f59e0b" : "var(--grid)",
            }}>
            {it.label}
          </button>
        ))}
        <div style={{ marginLeft: 12, display: "flex", gap: 2 }}>
          <button onClick={() => setSource("binance")} disabled={inReplay}
                  style={{ ...btn, color: source === "binance" ? "var(--fg)" : "var(--fg-dim)",
                           borderColor: source === "binance" ? "var(--fg-dim)" : "var(--grid)" }}>
            Binance
          </button>
          <button onClick={() => setSource("local")}
                  style={{ ...btn, color: source === "local" ? "var(--fg)" : "var(--fg-dim)",
                           borderColor: source === "local" ? "var(--fg-dim)" : "var(--grid)" }}>
            本地
          </button>
        </div>
        <span style={{ marginLeft: "auto", color: "var(--fg-dim)" }}>
          {loading ? "加载中..." : error ? `错误: ${error}` : `${klinesRef.current.length} bars`}
        </span>
      </div>
      <div ref={containerRef} style={{ flex: 1, position: "relative" }} />
    </div>
  );
}

const btn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid var(--grid)",
  color: "var(--fg-dim)",
  padding: "2px 8px",
  borderRadius: 3,
  fontSize: 11,
  cursor: "pointer",
};
