import { useEffect, useRef, useState } from "react";
import type { DepthFrame, SymbolSnapshot, Trade, WsMsg } from "./types";

const TAPE_MAX = 500;
const HEATMAP_MAX = 600;
const CVD_MAX = 3600;

export interface Store {
  symbols: Record<string, SymbolSnapshot>;
  connected: boolean;
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

export function useStore() {
  const [store, setStore] = useState<Store>({ symbols: {}, connected: false });
  const ref = useRef(store);
  ref.current = store;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let stop = false;
    let pending: WsMsg[] = [];
    let frame: number | null = null;

    function flush() {
      frame = null;
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      setStore((prev) => {
        const next: Record<string, SymbolSnapshot> = { ...prev.symbols };
        for (const m of batch) {
          if (m.type === "init") {
            return { symbols: m.data, connected: true };
          }
          const s = next[m.key];
          if (!s) continue;
          if (m.type === "trade") {
            const t = m.data;
            const tape = [t, ...s.tape].slice(0, TAPE_MAX);
            const cvd = pushCvd(s, t);
            next[m.key] = { ...s, tape, cvd, last_price: t.price };
          } else if (m.type === "depth") {
            const f: DepthFrame = m.data;
            const heatmap = [...s.heatmap, f].slice(-HEATMAP_MAX);
            next[m.key] = {
              ...s,
              bids: f.bids,
              asks: f.asks,
              heatmap,
              obi: f.obi ?? s.obi,
            };
          }
        }
        return { symbols: next, connected: prev.connected };
      });
    }

    function schedule(msg: WsMsg) {
      pending.push(msg);
      if (frame == null) frame = requestAnimationFrame(flush);
    }

    function connect() {
      if (stop) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.binaryType = "arraybuffer";
      const decoder = new TextDecoder();
      ws.onopen = () => setStore((p) => ({ ...p, connected: true }));
      ws.onclose = () => {
        setStore((p) => ({ ...p, connected: false }));
        if (!stop) setTimeout(connect, 1500);
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
  }, []);

  return store;
}
