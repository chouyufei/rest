import { useEffect, useRef, useState } from "react";
import type { DepthFrame, FootprintBin, ReplayParams, SymbolSnapshot, Trade, WsMsg } from "./types";

const TAPE_MAX = 500;
const HEATMAP_MAX = 600;
const CVD_MAX = 3600;
const FOOTPRINT_MAX_BINS = 30;
const FOOTPRINT_BIN_SEC = 60;

export type Mode = { kind: "live" } | { kind: "replay"; params: ReplayParams };

export interface Store {
  symbols: Record<string, SymbolSnapshot>;
  connected: boolean;
  mode: Mode;
  replayDone: boolean;
}

function pushCvd(s: SymbolSnapshot, t: Trade): [number, number, number][] {
  const signed = t.side === "buy" ? t.qty : -t.qty;
  const bucket = Math.floor(t.ts / 1000);
  const cvd = [...s.cvd];
  const prev = cvd.length ? cvd[cvd.length - 1][1] : 0;
  const last = cvd[cvd.length - 1];
  if (last && last[0] === bucket) {
    cvd[cvd.length - 1] = [bucket, last[1] + signed, t.price];
  } else {
    cvd.push([bucket, prev + signed, t.price]);
    if (cvd.length > CVD_MAX) cvd.splice(0, cvd.length - CVD_MAX);
  }
  return cvd;
}

function bucketPrice(price: number, tick: number): number {
  if (!tick) return price;
  return Math.round(Math.round(price / tick) * tick * 1e8) / 1e8;
}

function pushFootprint(s: SymbolSnapshot, t: Trade): FootprintBin[] {
  const sec = Math.floor(t.ts / 1000);
  const binTs = sec - (sec % FOOTPRINT_BIN_SEC);
  const price = bucketPrice(t.price, s.tick_size);
  const bins = s.footprint.slice();
  let last = bins[bins.length - 1];
  if (!last || last.ts !== binTs) {
    last = { ts: binTs, buy: 0, sell: 0, delta: 0, cells: [] };
    bins.push(last);
    if (bins.length > FOOTPRINT_MAX_BINS) bins.shift();
  } else {
    last = { ...last, cells: last.cells.slice() };
    bins[bins.length - 1] = last;
  }
  const idx = last.cells.findIndex((c) => c.price === price);
  const cell = idx >= 0 ? { ...last.cells[idx] } : { price, buy: 0, sell: 0 };
  if (t.side === "buy") cell.buy += t.qty;
  else cell.sell += t.qty;
  if (idx >= 0) last.cells[idx] = cell;
  else last.cells.push(cell);
  if (t.side === "buy") last.buy += t.qty;
  else last.sell += t.qty;
  last.delta = last.buy - last.sell;
  return bins;
}

function wsUrl(mode: Mode): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  if (mode.kind === "live") return `${proto}://${location.host}/ws`;
  const { market, symbol, tsFrom, tsTo, speed } = mode.params;
  const qs = new URLSearchParams({
    market, symbol, ts_from: String(tsFrom), ts_to: String(tsTo), speed: String(speed),
  });
  return `${proto}://${location.host}/ws/replay?${qs}`;
}

export function useStore() {
  const [store, setStore] = useState<Store>({
    symbols: {}, connected: false, mode: { kind: "live" }, replayDone: false,
  });
  const modeRef = useRef(store.mode);
  modeRef.current = store.mode;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let stop = false;
    let pending: WsMsg[] = [];
    let frame: number | null = null;
    const decoder = new TextDecoder();

    function flush() {
      frame = null;
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      setStore((prev) => {
        let symbols = prev.symbols;
        let replayDone = prev.replayDone;
        for (const m of batch) {
          if (m.type === "replay_done") {
            replayDone = true;
            continue;
          }
          if (m.type === "init") {
            symbols = m.data;
            continue;
          }
          const s = symbols[m.key];
          if (!s) continue;
          let next = symbols === prev.symbols ? { ...symbols } : symbols;
          symbols = next;
          if (m.type === "trade") {
            const t = m.data;
            const tape = [t, ...s.tape].slice(0, TAPE_MAX);
            const cvd = pushCvd(s, t);
            const footprint = pushFootprint(s, t);
            symbols[m.key] = { ...s, tape, cvd, footprint, last_price: t.price };
          } else if (m.type === "depth") {
            const f = m.data;
            const heatmap = [...s.heatmap, f].slice(-HEATMAP_MAX);
            symbols[m.key] = {
              ...s, bids: f.bids, asks: f.asks, heatmap,
              obi: f.obi ?? s.obi,
            };
          }
        }
        return { ...prev, symbols, replayDone };
      });
    }

    function schedule(msg: WsMsg) {
      pending.push(msg);
      if (frame == null) frame = requestAnimationFrame(flush);
    }

    function connect() {
      if (stop) return;
      ws = new WebSocket(wsUrl(modeRef.current));
      ws.binaryType = "arraybuffer";
      ws.onopen = () => setStore((p) => ({ ...p, connected: true, replayDone: false }));
      ws.onclose = () => {
        setStore((p) => ({ ...p, connected: false }));
        if (!stop && modeRef.current.kind === "live") setTimeout(connect, 1500);
      };
      ws.onmessage = (ev) => {
        try {
          const text = typeof ev.data === "string"
            ? ev.data
            : decoder.decode(ev.data as ArrayBuffer);
          schedule(JSON.parse(text));
        } catch (err) {
          console.warn("ws parse failed", err);
        }
      };
    }

    connect();
    return () => {
      stop = true;
      if (frame != null) cancelAnimationFrame(frame);
      ws?.close();
    };
  }, [store.mode]);

  function setMode(mode: Mode) {
    setStore((p) => ({ ...p, mode, symbols: {}, replayDone: false }));
  }

  return { ...store, setMode };
}
