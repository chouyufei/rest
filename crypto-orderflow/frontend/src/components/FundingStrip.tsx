import type { SymbolSnapshot } from "../lib/types";

interface Props { snap: SymbolSnapshot; }

function fmtCountdown(target: number): string {
  const diff = target - Date.now();
  if (diff <= 0) return "—";
  const s = Math.floor(diff / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${h}h ${String(m).padStart(2, "0")}m ${String(ss).padStart(2, "0")}s`;
}

export default function FundingStrip({ snap }: Props) {
  if (snap.market !== "futures") return null;
  const f = snap.funding;
  if (!f) return (
    <span style={{ color: "var(--fg-dim)" }}>资金费数据加载中...</span>
  );
  const rate = f.funding_rate;
  const ratePct = (rate * 100).toFixed(4) + "%";
  const color = rate >= 0 ? "var(--buy)" : "var(--sell)";
  return (
    <span style={{ display: "inline-flex", gap: 14, alignItems: "center" }}>
      <span style={{ color: "var(--fg-dim)" }}>
        标记 <b style={{ color: "var(--fg)" }}>{f.mark_price.toFixed(snap.tick_size < 1 ? 2 : 1)}</b>
      </span>
      <span style={{ color: "var(--fg-dim)" }}>
        费率 <b style={{ color }}>{ratePct}</b>
      </span>
      <span style={{ color: "var(--fg-dim)" }}>
        下次 <b style={{ color: "var(--fg)" }}>{fmtCountdown(f.next_funding_time)}</b>
      </span>
    </span>
  );
}
