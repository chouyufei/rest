import { useMemo, useState } from "react";
import CvdView from "./components/CvdView";
import FootprintView from "./components/FootprintView";
import HeatmapView from "./components/HeatmapView";
import ReplayBar from "./components/ReplayBar";
import TapeView from "./components/TapeView";
import { useStore } from "./lib/store";
import type { ReplayParams } from "./lib/types";

export default function App() {
  const { symbols, connected, mode, replayDone, setMode } = useStore();
  const keys = useMemo(() => Object.keys(symbols), [symbols]);
  const [active, setActive] = useState<string>("");
  const [showReplay, setShowReplay] = useState(false);

  const key = active && symbols[active] ? active : keys[0] || "";
  const snap = symbols[key];

  const isReplay = mode.kind === "replay";

  function startReplay(p: ReplayParams) {
    setActive(`${p.market}:${p.symbol}`);
    setMode({ kind: "replay", params: p });
  }
  function exitReplay() {
    setMode({ kind: "live" });
  }

  // 回放时下拉只显示一个交易对
  const currentMarket = isReplay ? mode.params.market : (snap?.market ?? "spot");
  const currentSymbol = isReplay ? mode.params.symbol : (snap?.symbol ?? "BTCUSDT");

  return (
    <div className="app" style={{ gridTemplateRows: showReplay ? "44px auto 1fr" : "44px 1fr" }}>
      <div className="toolbar">
        <h1>Crypto Orderflow</h1>

        <div style={{ display: "flex", gap: 4, background: "#13202c", padding: 2, borderRadius: 4 }}>
          <button
            onClick={() => { setShowReplay(false); exitReplay(); }}
            style={{
              ...tabStyle,
              background: !isReplay ? "var(--bg)" : "transparent",
              color: !isReplay ? "var(--fg)" : "var(--fg-dim)",
            }}>
            实时
          </button>
          <button
            onClick={() => setShowReplay((v) => !v)}
            style={{
              ...tabStyle,
              background: isReplay ? "var(--bg)" : "transparent",
              color: isReplay ? "#f59e0b" : "var(--fg-dim)",
            }}>
            回放{isReplay ? ` (${mode.params.speed}x)` : ""}
          </button>
        </div>

        <select value={key} onChange={(e) => setActive(e.target.value)} disabled={isReplay}>
          {keys.map((k) => {
            const s = symbols[k];
            return (
              <option key={k} value={k}>
                {s.market === "spot" ? "现货" : "U本位"} · {s.symbol}
                {s.ready ? "" : " (同步中)"}
              </option>
            );
          })}
        </select>

        {snap && (
          <span style={{ color: "var(--fg-dim)" }}>
            最新 <b style={{ color: "var(--fg)" }}>{snap.last_price?.toFixed(snap.tick_size < 1 ? 2 : 1) ?? "—"}</b>
            {" "}· OBI <b style={{ color: snap.obi >= 0 ? "var(--buy)" : "var(--sell)" }}>{snap.obi.toFixed(3)}</b>
          </span>
        )}

        <span className="status">
          {isReplay
            ? (replayDone ? "● 回放完毕" : connected ? "● 回放中" : "○ 连接中")
            : connected ? "● 已连接" : "○ 未连接"}
          {" "}· {isReplay ? "1" : keys.length} 路
        </span>
      </div>

      {showReplay && (
        <ReplayBar
          market={currentMarket as "spot" | "futures"}
          symbol={currentSymbol}
          busy={isReplay && !replayDone}
          onStart={startReplay}
          onCancel={exitReplay}
        />
      )}

      {snap ? (
        <div className="grid">
          <div className="panel" style={{ gridArea: "heatmap" }}>
            <div className="panel-head">订单簿热力图 (Bookmap)</div>
            <div className="panel-body"><HeatmapView snap={snap} /></div>
          </div>
          <div className="panel" style={{ gridArea: "cvd" }}>
            <div className="panel-head">CVD / Delta vs Price</div>
            <div className="panel-body"><CvdView snap={snap} /></div>
          </div>
          <div className="panel" style={{ gridArea: "foot" }}>
            <div className="panel-head">Footprint · tick {snap.tick_size}</div>
            <FootprintView snap={snap} />
          </div>
          <div className="panel" style={{ gridArea: "tape" }}>
            <div className="panel-head">Time &amp; Sales</div>
            <TapeView snap={snap} />
          </div>
        </div>
      ) : (
        <div style={{ padding: 24, color: "var(--fg-dim)" }}>
          {isReplay ? "等待回放数据 …" : "等待后端推送 …"}
        </div>
      )}
    </div>
  );
}

const tabStyle: React.CSSProperties = {
  border: "none",
  padding: "4px 10px",
  borderRadius: 3,
  fontSize: 12,
  cursor: "pointer",
};
