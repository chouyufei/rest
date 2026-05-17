import type { Trade } from "./types";

export interface Kline {
  ts: number;     // bin open time in ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  taker_buy_v: number;
}

export type Interval = "tick" | "1s" | "1m" | "5m" | "15m" | "1h" | "4h" | "1d" | "3d" | "1w";

export const INTERVALS: { id: Interval; label: string; ms: number | null }[] = [
  { id: "tick", label: "Tick", ms: null },
  { id: "1s",   label: "1s",   ms: 1_000 },
  { id: "1m",   label: "1m",   ms: 60_000 },
  { id: "5m",   label: "5m",   ms: 5 * 60_000 },
  { id: "15m",  label: "15m",  ms: 15 * 60_000 },
  { id: "1h",   label: "1h",   ms: 60 * 60_000 },
  { id: "4h",   label: "4h",   ms: 4 * 60 * 60_000 },
  { id: "1d",   label: "1d",   ms: 24 * 60 * 60_000 },
  { id: "3d",   label: "3d",   ms: 3 * 24 * 60 * 60_000 },
  { id: "1w",   label: "7d",   ms: 7 * 24 * 60 * 60_000 },
];

export function intervalMs(id: Interval): number | null {
  return INTERVALS.find((i) => i.id === id)?.ms ?? null;
}

export function applyTradeToKlines(arr: Kline[], t: Trade, ms: number): Kline[] {
  const binTs = Math.floor(t.ts / ms) * ms;
  if (arr.length === 0 || arr[arr.length - 1].ts < binTs) {
    arr.push({ ts: binTs, o: t.price, h: t.price, l: t.price, c: t.price, v: t.qty,
              taker_buy_v: t.side === "buy" ? t.qty : 0 });
  } else if (arr[arr.length - 1].ts === binTs) {
    const last = { ...arr[arr.length - 1] };
    last.h = Math.max(last.h, t.price);
    last.l = Math.min(last.l, t.price);
    last.c = t.price;
    last.v += t.qty;
    if (t.side === "buy") last.taker_buy_v += t.qty;
    arr[arr.length - 1] = last;
  }
  return arr;
}
