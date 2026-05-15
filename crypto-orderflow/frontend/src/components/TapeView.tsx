import { useMemo, useState } from "react";
import type { SymbolSnapshot } from "../lib/types";

interface Props { snap: SymbolSnapshot; }

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export default function TapeView({ snap }: Props) {
  const [minQty, setMinQty] = useState(0);
  const rows = useMemo(() => snap.tape.filter((t) => t.qty >= minQty), [snap.tape, minQty]);

  return (
    <div className="panel-body" style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "4px 10px", borderBottom: "1px solid var(--grid)", display: "flex", gap: 8, alignItems: "center" }}>
        <span style={{ color: "var(--fg-dim)" }}>大单过滤 ≥</span>
        <input
          type="number"
          value={minQty}
          step={snap.symbol.startsWith("BTC") ? 0.1 : 1}
          onChange={(e) => setMinQty(Number(e.target.value) || 0)}
          style={{ width: 80, background: "#1c232e", color: "var(--fg)", border: "1px solid var(--grid)", borderRadius: 4, padding: "2px 6px" }}
        />
        <span style={{ color: "var(--fg-dim)" }}>{rows.length}/{snap.tape.length}</span>
      </div>
      <div className="tape" style={{ flex: 1, overflowY: "auto" }}>
        <table>
          <tbody>
            {rows.map((t, i) => (
              <tr key={`${t.ts}-${i}`} className={t.side}>
                <td className="ts">{fmtTime(t.ts)}</td>
                <td className="price">{t.price.toFixed(snap.tick_size < 1 ? 2 : 1)}</td>
                <td className="qty">{t.qty.toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
