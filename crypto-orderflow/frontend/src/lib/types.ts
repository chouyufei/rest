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
}

export type WsMsg =
  | { type: "init"; data: Record<string, SymbolSnapshot> }
  | { type: "trade"; key: string; data: Trade }
  | { type: "depth"; key: string; data: DepthFrame };
