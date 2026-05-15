import { useEffect, useRef } from "react";
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  LineStyle,
} from "lightweight-charts";
import type { SymbolSnapshot } from "../lib/types";

interface Props { snap: SymbolSnapshot; }

export default function CvdView({ snap }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceRef = useRef<ISeriesApi<"Line"> | null>(null);
  const cvdRef = useRef<ISeriesApi<"Line"> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#0c0f14" }, textColor: "#7a8696" },
      grid: { vertLines: { color: "#1e2530" }, horzLines: { color: "#1e2530" } },
      rightPriceScale: { borderColor: "#1e2530" },
      timeScale: { borderColor: "#1e2530", timeVisible: true, secondsVisible: true },
      crosshair: { vertLine: { style: LineStyle.Dotted }, horzLine: { style: LineStyle.Dotted } },
      autoSize: true,
    });
    const price = chart.addLineSeries({
      color: "#d8e0ea",
      lineWidth: 1,
      priceScaleId: "right",
      lastValueVisible: true,
    });
    const cvd = chart.addLineSeries({
      color: "#f59e0b",
      lineWidth: 2,
      priceScaleId: "left",
      lastValueVisible: true,
    });
    chart.priceScale("left").applyOptions({ visible: true, borderColor: "#1e2530" });

    chartRef.current = chart;
    priceRef.current = price;
    cvdRef.current = cvd;
    return () => chart.remove();
  }, []);

  useEffect(() => {
    if (!priceRef.current || !cvdRef.current) return;
    const pts = snap.cvd;
    if (pts.length === 0) return;
    // de-dup ts (lightweight-charts requires strictly increasing time)
    const seen = new Set<number>();
    const pData: { time: number; value: number }[] = [];
    const cData: { time: number; value: number }[] = [];
    for (const [t, c, p] of pts) {
      if (seen.has(t)) continue;
      seen.add(t);
      pData.push({ time: t as number, value: p });
      cData.push({ time: t as number, value: c });
    }
    priceRef.current.setData(pData as any);
    cvdRef.current.setData(cData as any);
  }, [snap.cvd]);

  return <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />;
}
