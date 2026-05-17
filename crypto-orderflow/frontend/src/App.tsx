import { useEffect, useMemo, useState } from "react";
import ReplayBar from "./components/ReplayBar";
import Workspace from "./components/Workspace";
import { useStore } from "./lib/store";
import type { ReplayParams } from "./lib/types";

type GridMode = "1" | "2" | "4";

export default function App() {
  const { symbols, connected, mode, replayDone, setMode } = useStore();
  const keys = useMemo(() => Object.keys(symbols), [symbols]);
  const [active, setActive] = useState<string[]>([]);
  const [gridMode, setGridMode] = useState<GridMode>("1");
  const [showReplay, setShowReplay] = useState(false);

  const isReplay = mode.kind === "replay";

  // ensure active selection matches grid size
  useEffect(() => {
    const want = gridMode === "1" ? 1 : gridMode === "2" ? 2 : 4;
    setActive((cur) => {
      const filtered = cur.filter((k) => symbols[k]);
      const fillFrom = keys.filter((k) => !filtered.includes(k));
      const next = [...filtered, ...fillFrom].slice(0, want);
      return next;
    });
  }, [gridMode, keys.join(","), symbols]);

  function startReplay(p: ReplayParams) {
    setActive([`${p.market}:${p.symbol}`]);
    setGridMode("1");
    setMode({ kind: "replay", params: p });
  }
  function exitReplay() {
    setMode({ kind: "live" });
  }

  const activeSnaps = active.map((k) => symbols[k]).filter(Boolean);

  // replay mode forces single workspace
  const effectiveGrid = isReplay ? "1" : gridMode;
  const gridStyle: React.CSSProperties =
    effectiveGrid === "1" ? { gridTemplateColumns: "1fr", gridTemplateRows: "1fr" }
    : effectiveGrid === "2" ? { gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr" }
    : { gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr 1fr" };

  return (
    <div className="app" style={{ gridTemplateRows: showReplay ? "44px auto 1fr" : "44px 1fr" }}>
      <div className="toolbar">
        <h1>Crypto Orderflow</h1>

        <div style={{ display: "flex", gap: 4, background: "#13202c", padding: 2, borderRadius: 4 }}>
          <button onClick={() => { setShowReplay(false); exitReplay(); }}
                  style={tabStyle(!isReplay, "var(--fg)", "var(--fg-dim)")}>
            实时
          </button>
          <button onClick={() => setShowReplay((v) => !v)}
                  style={tabStyle(isReplay, "#f59e0b", "var(--fg-dim)")}>
            回放{isReplay ? ` (${mode.params.speed}x)` : ""}
          </button>
        </div>

        <div style={{ display: "flex", gap: 4, background: "#13202c", padding: 2, borderRadius: 4,
                      opacity: isReplay ? 0.4 : 1 }}>
          {(["1", "2", "4"] as GridMode[]).map((m) => (
            <button key={m} disabled={isReplay} onClick={() => setGridMode(m)}
                    style={tabStyle(gridMode === m, "var(--fg)", "var(--fg-dim)")}>
              {m === "1" ? "单图" : m === "2" ? "对比" : "网格"}
            </button>
          ))}
        </div>

        {active.map((k, i) => (
          <select key={i} value={k}
                  onChange={(e) => {
                    const next = active.slice();
                    next[i] = e.target.value;
                    setActive(next);
                  }} disabled={isReplay}>
            {keys.map((opt) => {
              const s = symbols[opt];
              return (
                <option key={opt} value={opt}>
                  {s.market === "spot" ? "现货" : "U本位"} · {s.symbol}
                  {s.ready ? "" : " (同步中)"}
                </option>
              );
            })}
          </select>
        ))}

        <span className="status">
          {isReplay
            ? (replayDone ? "● 回放完毕" : connected ? "● 回放中" : "○ 连接中")
            : connected ? "● 已连接" : "○ 未连接"}
          {" "}· {keys.length} 路
        </span>
      </div>

      {showReplay && (
        <ReplayBar
          market={(activeSnaps[0]?.market as "spot" | "futures") ?? "spot"}
          symbol={activeSnaps[0]?.symbol ?? "BTCUSDT"}
          busy={isReplay && !replayDone}
          onStart={startReplay}
          onCancel={exitReplay}
        />
      )}

      {activeSnaps.length === 0 ? (
        <div style={{ padding: 24, color: "var(--fg-dim)" }}>
          {isReplay ? "等待回放数据 …" : "等待后端推送 …"}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 1, background: "var(--grid)", minHeight: 0, ...gridStyle }}>
          {activeSnaps.map((snap, i) => (
            <Workspace key={i + ":" + snap.market + ":" + snap.symbol}
                       snap={snap} inReplay={isReplay}
                       compact={effectiveGrid !== "1"} />
          ))}
        </div>
      )}
    </div>
  );
}

function tabStyle(active: boolean, on: string, off: string): React.CSSProperties {
  return {
    border: "none",
    background: active ? "var(--bg)" : "transparent",
    color: active ? on : off,
    padding: "4px 10px",
    borderRadius: 3,
    fontSize: 12,
    cursor: "pointer",
  };
}
