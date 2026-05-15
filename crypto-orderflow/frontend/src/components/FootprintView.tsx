import { Fragment, useEffect, useMemo, useRef } from "react";
import type { SymbolSnapshot } from "../lib/types";

interface Props { snap: SymbolSnapshot; }

function fmtTs(s: number): string {
  const d = new Date(s * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function FootprintView({ snap }: Props) {
  const bins = snap.footprint;
  // unioned price ladder across visible bins (top of book centered)
  const wrapRef = useRef<HTMLDivElement>(null);

  const ladder = useMemo(() => {
    if (bins.length === 0) return [] as number[];
    const set = new Set<number>();
    for (const b of bins) for (const c of b.cells) set.add(c.price);
    return Array.from(set).sort((a, b) => b - a);
  }, [bins]);

  // index bins for quick lookup
  const indexed = useMemo(() => bins.map((b) => {
    const map = new Map<number, [number, number]>();
    for (const c of b.cells) map.set(c.price, [c.buy, c.sell]);
    return { ts: b.ts, map, delta: b.delta, buy: b.buy, sell: b.sell };
  }), [bins]);

  // auto-scroll to right edge whenever new bin appears
  const lastBinCount = useRef(0);
  useEffect(() => {
    if (wrapRef.current && bins.length !== lastBinCount.current) {
      wrapRef.current.scrollLeft = wrapRef.current.scrollWidth;
      lastBinCount.current = bins.length;
    }
  }, [bins.length]);

  if (bins.length === 0) {
    return <div className="panel-body" style={{ padding: 12, color: "var(--fg-dim)" }}>等待成交数据 …</div>;
  }

  // color scale by cell volume
  let maxCell = 0;
  for (const b of bins) for (const c of b.cells) {
    if (c.buy > maxCell) maxCell = c.buy;
    if (c.sell > maxCell) maxCell = c.sell;
  }
  if (maxCell === 0) maxCell = 1;

  const fmtPrice = (p: number) => p.toFixed(snap.tick_size < 1 ? 2 : 1);
  const fmtVol = (v: number) => v === 0 ? "" : v < 1 ? v.toFixed(3) : v < 100 ? v.toFixed(2) : v.toFixed(1);

  return (
    <div ref={wrapRef} className="footprint panel-body">
      <table>
        <thead>
          <tr>
            <th>价格</th>
            {indexed.map((b) => (
              <th key={b.ts} colSpan={2} style={{ minWidth: 80 }}>{fmtTs(b.ts)}</th>
            ))}
          </tr>
          <tr>
            <th></th>
            {indexed.map((b) => (
              <th key={b.ts} colSpan={2} style={{ color: b.delta >= 0 ? "var(--buy)" : "var(--sell)" }}>
                Δ {b.delta >= 0 ? "+" : ""}{b.delta.toFixed(2)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ladder.map((p) => (
            <tr key={p}>
              <td className="price">{fmtPrice(p)}</td>
              {indexed.map((b) => {
                const cell = b.map.get(p);
                const buy = cell?.[0] ?? 0;
                const sell = cell?.[1] ?? 0;
                const ab = Math.min(0.9, Math.log1p(buy) / Math.log1p(maxCell));
                const as = Math.min(0.9, Math.log1p(sell) / Math.log1p(maxCell));
                return (
                  <Fragment key={b.ts}>
                    <td style={{ background: `rgba(239,68,68,${as.toFixed(3)})`, color: sell ? "#fff" : "var(--fg-dim)" }}>
                      {fmtVol(sell)}
                    </td>
                    <td style={{ background: `rgba(31,191,117,${ab.toFixed(3)})`, color: buy ? "#fff" : "var(--fg-dim)" }}>
                      {fmtVol(buy)}
                    </td>
                  </Fragment>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
