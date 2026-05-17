import CvdView from "./CvdView";
import FootprintView from "./FootprintView";
import FundingStrip from "./FundingStrip";
import HeatmapView from "./HeatmapView";
import KlineView from "./KlineView";
import TapeView from "./TapeView";
import type { SymbolSnapshot } from "../lib/types";

interface Props {
  snap: SymbolSnapshot;
  inReplay: boolean;
  compact?: boolean;        // 多 symbol 网格时使用更紧凑布局
}

export default function Workspace({ snap, inReplay, compact = false }: Props) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{
        padding: "4px 10px", borderBottom: "1px solid var(--grid)", background: "#13202c",
        display: "flex", alignItems: "center", gap: 12, fontSize: 12,
      }}>
        <b style={{ color: "var(--fg)" }}>
          {snap.market === "spot" ? "现货" : "U本位"} · {snap.symbol}
        </b>
        <span style={{ color: "var(--fg-dim)" }}>
          最新 <b style={{ color: "var(--fg)" }}>
            {snap.last_price?.toFixed(snap.tick_size < 1 ? 2 : 1) ?? "—"}
          </b>
        </span>
        <span style={{ color: "var(--fg-dim)" }}>
          OBI <b style={{ color: snap.obi >= 0 ? "var(--buy)" : "var(--sell)" }}>{snap.obi.toFixed(3)}</b>
        </span>
        <FundingStrip snap={snap} />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "grid", gap: 1, background: "var(--grid)",
                    gridTemplateColumns: compact ? "1.4fr 1fr" : "1.4fr 1fr 280px",
                    gridTemplateRows: "1fr 1fr",
                    gridTemplateAreas: compact
                      ? `"kline  cvd"  "heatmap foot"`
                      : `"kline  cvd  tape"  "heatmap foot tape"` }}>
        <div className="panel" style={{ gridArea: "kline" }}>
          <div className="panel-body" style={{ position: "relative" }}>
            <KlineView snap={snap} inReplay={inReplay} />
          </div>
        </div>
        <div className="panel" style={{ gridArea: "cvd" }}>
          <div className="panel-head">CVD / Delta vs Price</div>
          <div className="panel-body"><CvdView snap={snap} /></div>
        </div>
        <div className="panel" style={{ gridArea: "heatmap" }}>
          <div className="panel-head">订单簿热力图 (Bookmap) · 信号: A=Absorption I=Iceberg</div>
          <div className="panel-body"><HeatmapView snap={snap} /></div>
        </div>
        <div className="panel" style={{ gridArea: "foot" }}>
          <div className="panel-head">Footprint · tick {snap.tick_size} · 黄框 = Stacked Imbalance</div>
          <FootprintView snap={snap} />
        </div>
        {!compact && (
          <div className="panel" style={{ gridArea: "tape" }}>
            <div className="panel-head">Time &amp; Sales</div>
            <TapeView snap={snap} />
          </div>
        )}
      </div>
    </div>
  );
}
