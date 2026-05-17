export type Side = "buy" | "sell";

export interface Trade {
  ts: number;
  price: number;
  qty: number;
  side: Side;
}

export interface DepthFrame {
  ts: number;
  bids: [number, number][];
  asks: [number, number][];
  obi?: number;
}

export interface FootprintCell { price: number; buy: number; sell: number; }
export interface FootprintBin {
  ts: number;
  buy: number;
  sell: number;
  delta: number;
  cells: FootprintCell[];
}

export interface SignalEvent {
  kind: "absorption" | "iceberg";
  ts: number;
  price: number;
  qty: number;
  side: "bid" | "ask";
  note?: string;
}

export interface FundingInfo {
  symbol: string;
  mark_price: number;
  index_price: number;
  funding_rate: number;
  next_funding_time: number;
  ts: number;
}

export interface SymbolSnapshot {
  symbol: string;
  market: "spot" | "futures";
  tick_size: number;
  ready: boolean;
  last_price: number | null;
  obi: number;
  bids: [number, number][];
  asks: [number, number][];
  tape: Trade[];
  cvd: [number, number, number][];
  footprint: FootprintBin[];
  heatmap: DepthFrame[];
  signals: SignalEvent[];
  funding?: FundingInfo | null;
}

export type WsMsg =
  | { type: "init"; data: Record<string, SymbolSnapshot> }
  | { type: "trade"; key: string; data: Trade }
  | { type: "depth"; key: string; data: DepthFrame }
  | { type: "signal"; key: string; data: SignalEvent }
  | { type: "funding"; key: string; data: FundingInfo }
  | { type: "replay_done" };

export interface ReplayParams {
  market: "spot" | "futures";
  symbol: string;
  tsFrom: number;
  tsTo: number;
  speed: number;
}

export interface HistoryRange {
  market: string;
  symbol: string;
  dates: { trades: string[]; snapshots: string[]; diffs: string[] };
}
