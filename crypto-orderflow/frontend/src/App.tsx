import { useMemo, useState } from "react";
import CvdView from "./components/CvdView";
import FootprintView from "./components/FootprintView";
import HeatmapView from "./components/HeatmapView";
import TapeView from "./components/TapeView";
import { useStore } from "./lib/store";

export default function App() {
  const { symbols, connected } = useStore();
  const keys = useMemo(() => Object.keys(symbols), [symbols]);
  const [active, setActive] = useState<string>("");

  const key = active && symbols[active] ? active : keys[0] || "";
  const snap = symbols[key];

  return (
    <div className="app">
      <div className="toolbar">
        <h1>Crypto Orderflow</h1>
        <select value={key} onChange={(e) => setActive(e.target.value)}>
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
          {connected ? "● 已连接" : "○ 未连接"} · {keys.length} 路
        </span>
      </div>
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
        <div style={{ padding: 24, color: "var(--fg-dim)" }}>等待后端推送 …</div>
      )}
    </div>
  );
}
