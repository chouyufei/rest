import { useEffect, useMemo, useState } from "react";
import type { HistoryRange, ReplayParams } from "../lib/types";

interface Props {
  market: "spot" | "futures";
  symbol: string;
  onStart: (p: ReplayParams) => void;
  onCancel: () => void;
  busy: boolean;
}

const SPEED_OPTIONS = [1, 5, 10, 30, 100];

function fmtLocalInput(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function ReplayBar({ market, symbol, onStart, onCancel, busy }: Props) {
  const [range, setRange] = useState<HistoryRange | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const now = useMemo(() => Date.now(), []);
  const [from, setFrom] = useState(fmtLocalInput(now - 5 * 60_000));
  const [to, setTo] = useState(fmtLocalInput(now - 60_000));
  const [speed, setSpeed] = useState(10);

  useEffect(() => {
    setLoading(true); setErr(null);
    fetch(`/api/history/range/${market}/${symbol}`)
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((d) => setRange(d))
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, [market, symbol]);

  const dates = range?.dates.trades ?? [];

  function go() {
    const tsFrom = new Date(from).getTime();
    const tsTo = new Date(to).getTime();
    if (Number.isNaN(tsFrom) || Number.isNaN(tsTo) || tsFrom >= tsTo) {
      setErr("时间范围无效");
      return;
    }
    setErr(null);
    onStart({ market, symbol, tsFrom, tsTo, speed });
  }

  return (
    <div style={{
      display: "flex", gap: 10, alignItems: "center", padding: "6px 12px",
      background: "#13202c", borderTop: "1px solid var(--grid)",
      borderBottom: "1px solid var(--grid)", fontSize: 12, color: "var(--fg-dim)",
    }}>
      <span>回放窗口：</span>
      <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)}
             style={inputStyle} disabled={busy}/>
      <span>→</span>
      <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)}
             style={inputStyle} disabled={busy}/>
      <span>速度</span>
      <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} style={inputStyle} disabled={busy}>
        {SPEED_OPTIONS.map((s) => <option key={s} value={s}>{s}x</option>)}
      </select>
      {busy
        ? <button onClick={onCancel} style={{ ...inputStyle, color: "#ef4444", borderColor: "#ef4444" }}>停止</button>
        : <button onClick={go} style={{ ...inputStyle, color: "var(--buy)", borderColor: "var(--buy)" }}>▶ 开始回放</button>}
      <span style={{ marginLeft: "auto", color: "var(--fg-dim)" }}>
        {loading ? "加载历史..." : err ? `错误: ${err}` : dates.length
          ? `历史日期: ${dates.join(", ")}`
          : "无历史数据 — 先在实时模式下采集一段时间"}
      </span>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "#1c232e",
  border: "1px solid var(--grid)",
  color: "var(--fg)",
  padding: "3px 6px",
  borderRadius: 4,
  fontSize: 12,
};
