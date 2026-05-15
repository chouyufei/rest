import { useEffect, useRef } from "react";
import type { SymbolSnapshot } from "../lib/types";

interface Props { snap: SymbolSnapshot; }

// Bookmap-style: x = time frames (left → right), y = price, color intensity = size.
// Overlay trade marks (green = buy aggressor, red = sell aggressor).
export default function HeatmapView({ snap }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cvs = ref.current;
    if (!cvs) return;
    const ctx = cvs.getContext("2d");
    if (!ctx) return;

    const parent = cvs.parentElement!;
    const dpr = window.devicePixelRatio || 1;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (cvs.width !== w * dpr || cvs.height !== h * dpr) {
      cvs.width = w * dpr;
      cvs.height = h * dpr;
      cvs.style.width = `${w}px`;
      cvs.style.height = `${h}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#0c0f14";
    ctx.fillRect(0, 0, w, h);

    const frames = snap.heatmap;
    if (frames.length === 0) {
      ctx.fillStyle = "#7a8696";
      ctx.font = "12px system-ui";
      ctx.fillText("等待深度数据 …", 12, 24);
      return;
    }

    // determine price range from most-recent frame + recent trades
    const last = frames[frames.length - 1];
    if (last.bids.length === 0 || last.asks.length === 0) return;
    const mid = (last.bids[0][0] + last.asks[0][0]) / 2;
    const tick = snap.tick_size;
    const halfRows = 80;
    const pxMin = mid - halfRows * tick;
    const pxMax = mid + halfRows * tick;

    // find max qty for color normalization
    let maxQ = 0;
    for (const f of frames) {
      for (const [, q] of f.bids) if (q > maxQ) maxQ = q;
      for (const [, q] of f.asks) if (q > maxQ) maxQ = q;
    }
    if (maxQ === 0) maxQ = 1;

    const colW = w / frames.length;
    const rowH = h / (halfRows * 2);

    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const x = i * colW;
      for (const [p, q] of f.bids) {
        if (p < pxMin || p > pxMax) continue;
        const y = h - ((p - pxMin) / (pxMax - pxMin)) * h;
        const alpha = Math.min(1, Math.log1p(q) / Math.log1p(maxQ));
        ctx.fillStyle = `rgba(31,191,117,${alpha.toFixed(3)})`;
        ctx.fillRect(x, y - rowH / 2, colW + 0.5, rowH + 0.5);
      }
      for (const [p, q] of f.asks) {
        if (p < pxMin || p > pxMax) continue;
        const y = h - ((p - pxMin) / (pxMax - pxMin)) * h;
        const alpha = Math.min(1, Math.log1p(q) / Math.log1p(maxQ));
        ctx.fillStyle = `rgba(239,68,68,${alpha.toFixed(3)})`;
        ctx.fillRect(x, y - rowH / 2, colW + 0.5, rowH + 0.5);
      }
    }

    // overlay recent trades on time axis (right side)
    const tapeWindow = 60_000; // 60s
    const nowTs = last.ts;
    const tStart = nowTs - tapeWindow;
    for (const t of snap.tape) {
      if (t.ts < tStart) break;
      if (t.price < pxMin || t.price > pxMax) continue;
      const x = w - ((nowTs - t.ts) / tapeWindow) * w;
      const y = h - ((t.price - pxMin) / (pxMax - pxMin)) * h;
      const r = Math.min(6, 1 + Math.log1p(t.qty));
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = t.side === "buy" ? "rgba(120,255,180,0.9)" : "rgba(255,140,140,0.9)";
      ctx.fill();
    }

    // mid line
    const midY = h - ((mid - pxMin) / (pxMax - pxMin)) * h;
    ctx.strokeStyle = "rgba(216,224,234,0.25)";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(w, midY);
    ctx.stroke();
    ctx.setLineDash([]);

    // price labels
    ctx.fillStyle = "#7a8696";
    ctx.font = "11px ui-monospace, monospace";
    ctx.textAlign = "right";
    for (let k = -2; k <= 2; k++) {
      const p = mid + k * halfRows * tick / 3;
      const y = h - ((p - pxMin) / (pxMax - pxMin)) * h;
      ctx.fillText(p.toFixed(snap.tick_size < 1 ? 2 : 1), w - 4, y - 2);
    }
  }, [snap]);

  return <canvas ref={ref} />;
}
