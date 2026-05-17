# Crypto Orderflow — 开发文档

币安现货 + U 本位合约的订单流分析系统。采集每笔成交与完整盘口深度，落盘 Parquet，前端实时可视化 K 线、热力图、Footprint、CVD、Time & Sales，并支持历史回放。

- 后端：Python 3.9+ / FastAPI / asyncio / pyarrow / duckdb
- 前端：React 18 / TypeScript / Vite / lightweight-charts
- 数据：Parquet（按日/按 flush 切片），无外部数据库依赖

---

## 目录

1. [整体架构](#1-整体架构)
2. [目录结构](#2-目录结构)
3. [核心数据流](#3-核心数据流)
4. [后端模块](#4-后端模块)
5. [前端模块](#5-前端模块)
6. [持久化与文件格式](#6-持久化与文件格式)
7. [REST API](#7-rest-api)
8. [WebSocket 协议](#8-websocket-协议)
9. [关键算法](#9-关键算法)
10. [配置项](#10-配置项)
11. [开发与运行](#11-开发与运行)
12. [网络兼容](#12-网络兼容)
13. [性能与瓶颈](#13-性能与瓶颈)
14. [已知限制](#14-已知限制)
15. [扩展指引](#15-扩展指引)

---

## 1. 整体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Binance Exchange                            │
│   spot WS  ─  futures WS  ─  spot REST(snapshot)  ─  futures REST   │
└────────────┬───────────────────────────────────────────────────────┘
             │ 8 路并发 (4 交易对 × 现货/合约)
             ▼
┌────────────────────────────────────────────────────────────────────┐
│ 后端 (FastAPI + asyncio, 进程内单实例)                             │
│                                                                    │
│  collectors/binance_ws ──────► state/SymbolState (簿/分析/Tape)   │
│              │  │                       │                          │
│              │  └─► storage/writer (Parquet flush 30s/5000 rows)  │
│              │                          │                          │
│              ▼                          ▼                          │
│  analytics/                       Hub.broadcast (asyncio.Queue)   │
│   ├─ orderbook/book               │                                │
│   ├─ analytics/cvd                ▼                                │
│   ├─ analytics/footprint        WS /ws (实时)                      │
│   ├─ analytics/heatmap          WS /ws/replay (历史)              │
│   ├─ analytics/signals          REST /api/snapshot                 │
│   ├─ analytics/klines           REST /api/klines/{binance|local}   │
│   └─ collectors/funding (30s 轮询合约费率)                         │
└────────────────────────┬───────────────────────────────────────────┘
                         │ WebSocket / HTTPS
                         ▼
┌────────────────────────────────────────────────────────────────────┐
│ 前端 (Vite + React)                                                │
│                                                                    │
│  lib/store (useStore)  ◄── WS 反序列化 + rAF 批量 setState         │
│       │                                                            │
│       ▼                                                            │
│  App (1/2/4 网格切换, 实时/回放切换)                                │
│       │                                                            │
│       └─► Workspace × N                                            │
│            ├─ KlineView   (lightweight-charts + interval picker)   │
│            ├─ HeatmapView (Canvas Bookmap 风格 + 信号标记)          │
│            ├─ FootprintView (Stacked Imbalance 高亮)                │
│            ├─ CvdView                                              │
│            ├─ TapeView                                             │
│            └─ FundingStrip                                         │
└────────────────────────────────────────────────────────────────────┘
```

---

## 2. 目录结构

```
crypto-orderflow/
├── backend/
│   ├── requirements.txt              依赖锁定
│   ├── run.py                        uvicorn 入口
│   └── app/
│       ├── config.py                 交易对配置 + 环境变量
│       ├── state.py                  SymbolState + Hub (广播总线)
│       ├── orderbook/
│       │   └── book.py               L2 簿 (SortedDict, snapshot+diff)
│       ├── analytics/
│       │   ├── cvd.py                Cumulative Volume Delta
│       │   ├── footprint.py          时间×价位的 buy/sell 体积
│       │   ├── heatmap.py            深度环形缓冲 + OBI
│       │   ├── signals.py            Absorption / Iceberg 检测
│       │   └── klines.py             本地 OHLCV 聚合 + Binance REST 代理
│       ├── collectors/
│       │   ├── binance_ws.py         WS 客户端 + 簿同步状态机
│       │   └── funding.py            合约资金费 30s 轮询
│       ├── storage/
│       │   ├── writer.py             Parquet flush (一次 flush = 一文件)
│       │   └── replay.py             duckdb 查询 + 回放流生成
│       └── api/
│           └── server.py             FastAPI 路由 + WS endpoint
└── frontend/
    ├── package.json
    ├── vite.config.ts                Dev proxy /api /ws → 8000
    ├── index.html
    └── src/
        ├── main.tsx                  React 入口
        ├── App.tsx                   顶栏 + 网格布局调度
        ├── styles.css
        ├── lib/
        │   ├── types.ts              所有共享 TS 类型
        │   ├── store.ts              WS 客户端 + 状态合并 + 客户端 CVD/Footprint
        │   └── klines.ts             interval 表 + tape→kline 增量算法
        └── components/
            ├── Workspace.tsx         单交易对完整工作区 (含所有视图)
            ├── KlineView.tsx         蜡烛 + 量柱 + 信号标记
            ├── HeatmapView.tsx       Canvas 热力图 + 成交点 + 信号
            ├── FootprintView.tsx     表格 + Stacked Imbalance 高亮
            ├── CvdView.tsx           Lightweight Charts CVD vs Price
            ├── TapeView.tsx          逐笔流水 + 大单过滤
            ├── FundingStrip.tsx      合约费率/标记价/倒计时
            └── ReplayBar.tsx         回放窗口 + 速度选择
```

---

## 3. 核心数据流

### 实时模式（每个交易对独立 8 路 WS）

```
Binance @trade/@aggTrade ──┐
                           ├─► binance_ws._on_trade
                           │     ├─► state.on_trade
                           │     │     ├─► cvd.add_trade
                           │     │     ├─► footprint.add_trade
                           │     │     ├─► tape.append
                           │     │     └─► signals.on_trade  ─┐
                           │     └─► storage.on_trade         │
                           │     └─► hub.broadcast {trade}    │
                           │                                  │
Binance @depth ────────────┼─► binance_ws._on_depth          │
                           │     ├─► book.apply_diff          │
                           │     └─► storage.on_diff          │
                           │                                  │
1Hz sampler (asyncio)──────┼─► state.sample_depth (top-N)    │
                                 ├─► heatmap.push             │
                                 ├─► obi 重算                  │
                                 ├─► storage.on_snapshot      │
                                 └─► hub.broadcast {depth}    │
                                                              │
funding loop (30s)──────────► hub.broadcast {funding}         │
                                                              │
signals.on_trade 触发─────────► hub.broadcast {signal} ◄──────┘
```

`Hub` 是个 fan-out：内部维护 `set[asyncio.Queue]`，每个 WS 连接订阅一个 queue。`broadcast()` 把消息 `put_nowait` 进每个 queue（队列满直接丢该订阅者，避免阻塞采集）。

### 回放模式

```
GET /ws/replay?market=&symbol=&ts_from=&ts_to=&speed=N
        │
        ▼
storage.replay.Replayer
   ├─ HistoryReader.trades       (duckdb glob read_parquet)
   ├─ HistoryReader.snapshots
   └─ stream():
        events = merge(trades, snapshots) sort by ts
        yield init {tick_size, current top bids/asks}
        for each event:
            await asyncio.sleep((evt_ts - start_ts) / 1000 / speed - elapsed)
            yield {trade|depth, ...}
        yield {replay_done}
```

前端的 `store` 切到回放 mode 时直接换 WS URL，客户端的视图组件完全不感知 —— 因为消息格式跟实时流一样（同一套 `WsMsg` 类型）。

---

## 4. 后端模块

### `config.py`
- `SymbolSpec(market, symbol, tick_size, footprint_bin_sec)`：交易对定义
- `SYMBOLS`：默认 4 个，可通过 `ORDERFLOW_SYMBOLS` 环境变量覆盖
- Binance 端点常量，全部支持环境变量覆盖

### `orderbook/book.py`
- `OrderBook`：L2 簿
- `bids: SortedDict`（按价格降序）/ `asks: SortedDict`（升序）
- `load_snapshot(bids, asks, last_update_id)`：REST 快照写入
- `apply_diff(bids, asks)`：增量更新，qty=0 删除
- `top_n(n)`：返回 `(list[(price,qty)], list[(price,qty)])`

### `analytics/cvd.py`
- 1 秒分桶累积 buy-sell 体积
- `buyer_is_maker=True` ⇒ 卖盘主动 ⇒ -qty；否则 +qty
- 保留最近 3600 个桶（1 小时）

### `analytics/footprint.py`
- 时间×价位的二维聚合
- 价位按 `tick_size` 量化
- 每 bin 保存 `cells: {price: [buy, sell]}` 以及 `delta = buy - sell`
- 保留最近 120 个 bin（默认 1min × 120 = 2 小时）

### `analytics/heatmap.py`
- `DepthHeatmap`：定长 deque，每帧一个 `{ts, bids[60], asks[60]}`
- `order_book_imbalance(bids, asks, depth=10)`：(BV - AV) / (BV + AV)

### `analytics/signals.py`
- `SignalDetector`，含两个检测器
  - **Absorption**：15s 窗口内同价位累积成交量 ≥ 8× 单笔中位数 **且** ≥ 5× 顶档均量 **且** 价格区间 ≤ 0.05%
  - **Iceberg**：60s 窗口内同价位 ≥ 6 笔 **且** 累积量 ≥ 3× 顶档均量
- 每价位独立冷却（5s/10s）防止连发
- 顶部常量直接调阈值

### `analytics/klines.py`
- `INTERVAL_MS`：1s / 1m / 5m / 15m / 1h / 4h / 1d / 3d / 1w
- `aggregate_local(market, symbol, interval, ts_from, ts_to, limit)`：duckdb SQL 聚合 trades.parquet
  - 使用 `arg_min(price, ts)` 作为 open、`arg_max` 作为 close
  - 同时计算 taker buy volume (`buyer_is_maker=False` 的累积量)
- `fetch_binance_klines(market, symbol, interval, limit)`：转发到 `/api/v3/klines` 或 `/fapi/v1/klines`

### `collectors/binance_ws.py`
- `SymbolStream`：一个交易对一个实例
- WS 永久重连循环
- `_bootstrap_snapshot`：连接 WS 后等 1 秒，让 buffer 攒事件，再拉 REST snapshot，按 Binance 文档算法对齐 U/u/pu
- `_apply`：增量应用 diff，检测 gap → 强制 resync
- `_depth_sampler`：每秒为所有交易对采样 top-N 推热力图 + storage + 广播

### `collectors/funding.py`
- 仅对合约交易对生效
- 30 秒轮询 `/fapi/v1/premiumIndex`，写入 `SymbolState.funding`，广播

### `storage/writer.py`
- `StorageHub`：单例
- 三种 sink：`trades` / `snapshots` / `diffs`，schema 用 pyarrow
- 行级内存 buffer，达到 `WRITER_FLUSH_ROWS` 或 `WRITER_FLUSH_SEC` 间隔时刷盘
- **每次 flush 写一个独立文件** (`{date}.{epoch_ms}.parquet`)，文件立即可读
- 压缩 zstd
- 进程退出时 shutdown 钩子触发最后一次 flush

### `storage/replay.py`
- `HistoryReader`：duckdb 连接 + glob 读 Parquet
- `Replayer.stream()`：异步生成器，按事件时间戳调速 `asyncio.sleep`

### `state.py`
- `SymbolState`：一个交易对所有内存状态的总和
- `Hub`：fan-out 中心，提供 `subscribe()` / `broadcast()`
- `snapshot_full()`：返回轻量初始化数据（不含历史 tape/footprint/heatmap，避免初始帧过大）

### `api/server.py`
- FastAPI 应用 + lifecycle hooks
- REST 端点和 WS 端点

---

## 5. 前端模块

### `lib/types.ts`
所有共享类型：`Trade` / `DepthFrame` / `FootprintBin` / `SymbolSnapshot` / `SignalEvent` / `FundingInfo` / `WsMsg` 等。

### `lib/store.ts`
- `useStore()`：自定义 hook，管理 WS 连接、消息合并、模式切换
- **rAF 批量更新**：所有 WS 消息攒到下一帧再一次性 `setStore`，避免高频成交触发 React 重渲染
- **客户端增量计算**：
  - `pushCvd`：每个 trade 更新当前秒桶
  - `pushFootprint`：每个 trade 累加进当前 60s bin
  - heatmap：每个 depth 事件 push 进 ring
- **模式切换**：`mode = {kind:"live"} | {kind:"replay", params}`，URL 不同；切换时清空 symbols
- **断线重连**：仅实时模式自动重连（回放结束不重连）

### `lib/klines.ts`
- `INTERVALS` 表：id + label + ms（tick 的 ms 为 null）
- `applyTradeToKlines(arr, trade, ms)`：把一笔成交折进数组最后一根 bar 或开新 bar

### `components/Workspace.tsx`
单交易对的工作区：上方 K 线 / CVD，下方热力图 / Footprint，右侧（非紧凑模式）Tape。

### `components/KlineView.tsx`
- 周期切换 + 数据源切换（Binance / 本地）
- 切周期/数据源时 `fetch(/api/klines/...)` 拉历史
- 每次 trade 触发 useEffect，把最新一笔 fold 进当前 bar，调 `series.update(...)`
- 信号通过 `series.setMarkers` 叠加

### `components/HeatmapView.tsx`
- `<canvas>` 手绘
- 横轴 = 历史帧索引，纵轴 = 价格（mid ± halfRows × tick）
- 每个 (帧, 价位) 颜色透明度 = `log(qty)/log(maxQty)`
- 右侧叠加最近 60s 成交（圆点，绿/红、半径 ∝ log(qty)）
- 信号叠加（黄圈 = Absorption，青框 = Iceberg）

### `components/FootprintView.tsx`
- 表格：行 = 价格，列 = 时间 bin × (sell, buy)
- 单元格 buy/sell ≥ 3 且连续 3+ 档同向 → 琥珀色描边

### `components/CvdView.tsx`
- 双 Y 轴：左 CVD（橙色），右价格（白色）
- lightweight-charts 双 line series

### `components/ReplayBar.tsx`
- 加载时调 `/api/history/range` 看哪天有数据
- datetime-local + 速度下拉
- 开始 → `onStart(params)` 切换 store mode

### `App.tsx`
- 顶栏：实时/回放 tab、1/2/4 网格 tab、symbol 下拉、连接状态
- 网格布局：单图 (1col×1row) / 对比 (2col×1row) / 网格 (2col×2row)
- 回放模式强制单图

---

## 6. 持久化与文件格式

### 目录布局
```
data/
├── trades/
│   ├── spot/BTCUSDT/2026-05-17.1779018661321.parquet
│   ├── spot/BTCUSDT/2026-05-17.1779018666326.parquet
│   ├── spot/ETHUSDT/...
│   └── futures/...
├── snapshots/   (同结构)
└── diffs/       (同结构)
```

文件名 `{YYYY-MM-DD}.{flush_ms}.parquet`：日期前缀方便日级别查询、flush_ms 避免冲突且天然排序。

### Schema

**trades**
| 字段 | 类型 | 含义 |
|---|---|---|
| ts | int64 | 毫秒时间戳 |
| price | float64 | 成交价 |
| qty | float64 | 成交量（base） |
| buyer_is_maker | bool | true=卖盘主动 |

**snapshots** （1Hz 应用层采样）
| 字段 | 类型 |
|---|---|
| ts | int64 |
| bids_p | list&lt;float64&gt; |
| bids_q | list&lt;float64&gt; |
| asks_p | list&lt;float64&gt; |
| asks_q | list&lt;float64&gt; |
| obi | float32 |

**diffs** （Binance 原始 depth diff 事件）
| 字段 | 类型 |
|---|---|
| ts | int64 (E) |
| U | int64 |
| u | int64 |
| pu | int64 (-1 表 spot 无 pu) |
| bids_p / bids_q / asks_p / asks_q | list&lt;float64&gt; |

### 用 duckdb 直查
```sql
-- 任意 SQL 都行，无需启动后端
duckdb -c "
SELECT
  date_trunc('hour', to_timestamp(ts/1000)) AS h,
  SUM(qty) AS vol,
  AVG(price) AS avg_p
FROM 'data/trades/spot/BTCUSDT/*.parquet'
GROUP BY h
ORDER BY h DESC LIMIT 24;
"
```

---

## 7. REST API

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/symbols` | 列出所有配置交易对 + 是否同步 |
| GET | `/api/snapshot/{market}/{symbol}` | 当前盘口顶部 + 信号 + 资金费 |
| GET | `/api/klines/intervals` | 支持的 K 线周期列表 |
| GET | `/api/klines/binance/{market}/{symbol}?interval=1m&limit=500` | 转发 Binance |
| GET | `/api/klines/local/{market}/{symbol}?interval=1m&ts_from=&ts_to=&limit=` | duckdb 聚合本地 |
| GET | `/api/history/range/{market}/{symbol}` | 落盘了哪些日期 |
| WS | `/ws` | 实时推送 |
| WS | `/ws/replay?market=&symbol=&ts_from=&ts_to=&speed=` | 历史回放 |

CORS 全开（dev 用），生产请收紧。

---

## 8. WebSocket 协议

服务端**全部用 `send_bytes(orjson.dumps(...))` 发二进制 JSON**，前端 `binaryType = "arraybuffer"` 后用 `TextDecoder` 解码。

### 消息类型

```ts
type WsMsg =
  | { type: "init"; data: Record<"spot:BTCUSDT" | ..., SymbolSnapshot> }
  | { type: "trade"; key: string; data: Trade }
  | { type: "depth"; key: string; data: DepthFrame }
  | { type: "signal"; key: string; data: SignalEvent }
  | { type: "funding"; key: string; data: FundingInfo }
  | { type: "replay_done" };
```

**key 约定**：`"{market}:{symbol}"`，例如 `"spot:BTCUSDT"` / `"futures:ETHUSDT"`。

**init 设计要点**：包含每个交易对的元数据 + 当前盘口顶部，**但不含历史 tape/footprint/heatmap/cvd 数组**。早期版本曾把全部历史塞进 init，单帧可达几十 MB，被 Vite 代理 reset。现在改为客户端从实时流自己累积。

---

## 9. 关键算法

### 9.1 订单簿 snapshot + diff 同步

按 [Binance 官方 doc](https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-streams.md#how-to-manage-a-local-order-book-correctly) 实现：

```
1. 打开 WS @depth 流，缓冲所有事件不应用
2. 1s 后 GET /api/v3/depth?limit=5000，记 lastUpdateId
3. spot:
     丢弃所有 u <= lastUpdateId 的事件
     第一个有效事件须满足 U <= lastUpdateId+1 <= u
4. futures:
     丢弃 u < lastUpdateId 的事件
     第一个有效事件须满足 U <= lastUpdateId <= u
     后续事件须 pu == previous_u
5. 顺序应用 b/a 数组（qty=0 删除）
6. 任意阶段检测到 gap → 标记 ready=False 重新走 1
```

实现见 `binance_ws.SymbolStream._bootstrap_snapshot` 与 `_apply`。

### 9.2 CVD

```python
signed = -qty if buyer_is_maker else qty
cvd += signed
```
1 秒分桶累加，便于折线显示。

### 9.3 Footprint

时间维度按 `footprint_bin_sec`（默认 60）切 bin，价格维度按 `tick_size` 量化：
```python
bin_ts = floor(ts/1000/bin_sec) * bin_sec
price_bin = round(price / tick) * tick
buy_or_sell = "sell" if buyer_is_maker else "buy"
bins[bin_ts][price_bin][buy_or_sell] += qty
```

### 9.4 Stacked Imbalance（前端）

```ts
ratio_ok(buy, sell) := buy/sell >= 3 || sell/buy >= 3
// 在 bin 内按价格降序遍历，找同方向连续 3+ 档
```

### 9.5 Absorption 检测

窗口 15s，对每笔新成交检查该价位：
```
items = window 内同 price 的成交
require len(items) >= 3
cum   = sum(qty for ... in items)
median= median(qty)
require cum >= 8 × median
require cum >= 5 × top_of_book_avg_qty
require (window 内全部价格的 hi-lo) / mid <= 0.0005
side = "bid" if 主动卖 > 主动买 else "ask"
cooldown 5s per price
```

### 9.6 Iceberg 检测

窗口 60s，对每个价位维护一个 deque：
```
require len(buf) >= 6 prints
cum >= 3 × top_of_book_avg_qty
cooldown 10s per price
```

### 9.7 K 线聚合（本地）

duckdb SQL：
```sql
WITH t AS (
  SELECT ts, price, qty, buyer_is_maker,
         CAST(FLOOR(ts/?) * ? AS BIGINT) AS bin_ts
  FROM read_parquet(?) WHERE ts BETWEEN ? AND ?
)
SELECT bin_ts,
       arg_min(price, ts) AS o,
       MAX(price) AS h,
       MIN(price) AS l,
       arg_max(price, ts) AS c,
       SUM(qty) AS v,
       SUM(CASE WHEN buyer_is_maker=FALSE THEN qty ELSE 0 END) AS taker_buy_v
FROM t GROUP BY bin_ts ORDER BY bin_ts DESC LIMIT ?
```

### 9.8 K 线增量（前端）

当前未收盘那根 bar 不轮询后端，前端拿到每笔 trade 后：
```ts
binTs = floor(t.ts / intervalMs) * intervalMs
if 最后一根.ts < binTs:  push 新 bar
else if 最后一根.ts == binTs:  high=max, low=min, c=t.price, v+=qty
chart.update(最后一根)
```

---

## 10. 配置项

全部通过环境变量，无配置文件。

| 变量 | 默认 | 说明 |
|---|---|---|
| `ORDERFLOW_SYMBOLS` | 4 个内置 | 格式 `market:symbol:tick`，逗号分隔。例 `spot:BTCUSDT:1,futures:ETHUSDT:0.1` |
| `BINANCE_SPOT_WS` | `wss://stream.binance.com:9443/stream` | 现货 WS |
| `BINANCE_SPOT_REST` | `https://api.binance.com` | 现货 REST |
| `BINANCE_FUTURES_WS` | `wss://fstream.binance.com/stream` | 合约 WS |
| `BINANCE_FUTURES_REST` | `https://fapi.binance.com` | 合约 REST |
| `ORDERFLOW_DATA_DIR` | `data` | 持久化根目录 |
| `ORDERFLOW_PERSIST` | `1` | 设 `0` 完全关闭落盘 |
| `ORDERFLOW_FLUSH_SEC` | `30` | 自动 flush 周期 |
| `ORDERFLOW_FLUSH_ROWS` | `5000` | 单 sink 行数达到立即 flush |
| `ORDERFLOW_PERSIST_LEVELS` | `60` | 快照持久化的档位数 |

---

## 11. 开发与运行

### 后端
```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python run.py            # 监听 :8000
```

> Windows 下 `.venv/bin/` 换成 `.venv/Scripts/`。

### 前端
```bash
cd frontend
npm install
npm run dev                        # 监听 :5173, /api 和 /ws 代理到 :8000
```

访问 http://localhost:5173 。生产构建 `npm run build`，产物在 `dist/`。

### 一些常见命令

```bash
# 查看落盘统计
ls -la data/trades/spot/BTCUSDT/ | head
duckdb -c "SELECT COUNT(*) FROM 'data/trades/spot/BTCUSDT/*.parquet'"

# 跑一段时间数据后查近 5min K
curl 'http://localhost:8000/api/klines/local/spot/BTCUSDT?interval=1m&limit=10'

# 测试回放
TS_TO=$(($(date +%s%3N) - 30000))
TS_FROM=$((TS_TO - 60000))
echo "ws://localhost:8000/ws/replay?market=spot&symbol=BTCUSDT&ts_from=$TS_FROM&ts_to=$TS_TO&speed=10"
```

---

## 12. 网络兼容

### 中国大陆
`api.binance.com` 与 `fapi.binance.com` 通常不可达。解决方案：

**方案 A：用公开数据镜像（仅现货）**
```bash
export BINANCE_SPOT_REST=https://data-api.binance.vision
export BINANCE_SPOT_WS=wss://data-stream.binance.vision/stream
export ORDERFLOW_SYMBOLS="spot:BTCUSDT:1,spot:ETHUSDT:0.1"
```

**方案 B：代理**
- 启动 Clash / V2ray 等，监听 7890
- 因为 `websockets` 库不读 `HTTPS_PROXY` 环境变量，需要单独处理（待补 PR）

### 区域限制 (HTTP 451)
Binance 部分地区返回 451。同样改用 vision 镜像或切到合规区域的服务器。

### Vite WS 代理 EPIPE/ECONNRESET
`vite.config.ts` 已对 ECONNREFUSED/EPIPE 静默处理。后端重启时这些瞬态错误属正常现象。

---

## 13. 性能与瓶颈

### 当前实测（沙箱环境）
- 单交易对 BTCUSDT 现货约 30-100 trades/s
- 4 路（2 现货 + 2 合约）合计写入 ~200-500 行/s（trades + diffs 总和）
- 30s flush 产出文件 ~50KB-2MB 压缩后
- 内存稳态：< 200MB

### 瓶颈点
1. **Hub.broadcast 队列**：单订阅者 `maxsize=2000`，若前端处理过慢，老消息会被 `QueueFull` 丢弃并 unsubscribe。前端开了 rAF 批处理，目前未观察到溢出。
2. **Parquet 小文件**：30s 一文件 × 4 symbols × 3 kinds = 8640 文件/天/4交易对。duckdb glob 性能良好但 inode 会增长。可周期跑 daily compaction（见扩展）。
3. **回放预加载**：`Replayer._merge` 一次性把全窗口 trades + snapshots 加载进内存。回放超长窗口（数小时以上）会吃光内存。可改成游标流式。
4. **K 线 incremental 加在每笔 trade**：当周期不是 tick 且交易频繁时，每笔触发一次 `chart.update` —— lightweight-charts 性能没问题，但 React useEffect 依赖 `snap.tape` 每帧变 reference，可能多算一次。可优化为去抖。

### 容量估算（一天单交易对 BTC 现货）
- trades：~5M 行 × ~30B/行 → Parquet 压缩约 50-80MB
- snapshots：86400 × 60×2 × 16B + 元数据 → 压缩约 30MB
- diffs：每秒 ~10 帧 × 60 档 → 压缩约 50-100MB
- 合计单交易对约 150-200MB/天，全 4 交易对约 600MB-1GB/天

---

## 14. 已知限制

1. **没有跨进程持久化的 funding 历史**。资金费率只存当前值在内存，不入 Parquet。
2. **回放只用 1Hz snapshot 重建盘口**。diffs 虽然存了，但回放路径还没消费它们。要做 tick-by-tick 完整重放需要新建一个 `DiffReplayer`。
3. **没有用户认证 / 权限**。所有端点公开。
4. **Signal 检测的 cooldown 是 per-price 的**。同价位的强信号被压制 5-10 秒，跨价位不影响。极端行情下仍可能集中触发。
5. **多交易对网格里所有交易对共用同一个 WS**。当前实现是一条 `/ws` 接收所有 symbol 的事件，前端按 `key` 派发。不存在多连接同步问题。
6. **Python 3.10+ 才能直连主网**（FastAPI Query 参数限制）。已通过 `Optional[int]` 兼容到 3.9。3.8 一些其它新语法仍可能炸，建议 3.10+。

---

## 15. 扩展指引

### 加一个新指标
1. 在 `analytics/` 新建模块，写一个有 `add_trade()` 或 `on_depth()` 接口的类
2. 在 `state.SymbolState.__init__` 实例化
3. 在 `state.on_trade` 或 `sample_depth` 调用
4. 决定是把结果塞 `snapshot_full` 还是单独广播
5. 前端 `lib/types.ts` 加类型，`lib/store.ts` 加处理分支
6. 新组件 / 在已有组件叠加

### 加一个新视图
- 加 `components/XxxView.tsx`
- 在 `Workspace.tsx` 的 grid 里布局
- 如果需要新数据源，加对应 REST 端点

### 加新的持久化字段
1. 改 `storage/writer.py` 中对应 schema（注意 schema 变了无法读旧文件 —— 加版本前缀目录或保持向后兼容字段）
2. 改 `storage/replay.py` 的 SELECT 列
3. 改 `replay.Replayer._merge` 解包逻辑

### 加历史 daily compaction
- 写个独立脚本 `scripts/compact.py`，每天凌晨：
  ```python
  duckdb.execute("COPY (SELECT * FROM 'data/trades/spot/BTCUSDT/2026-05-17.*.parquet' ORDER BY ts) TO 'data/trades/spot/BTCUSDT/2026-05-17.parquet'")
  # 然后删除小文件
  ```
- 注意：不能 compact 当天的（仍在写入），跑昨天及以前。

### 切换到 ClickHouse
- 起一个 ClickHouse 实例，用 `clickhouse-driver`
- 新建 `storage/clickhouse_sink.py` 实现同接口（`on_trade` / `on_snapshot` / `on_diff` / `flush` / `stop`）
- 替换 `storage.writer.storage` 单例

### 加 Spread/溢价子面板
- 前端 store 已有所有 symbol 的最新价
- 新组件订阅两个 key (`spot:BTCUSDT` + `futures:BTCUSDT`)
- 在多 symbol 网格模式下顶部加一个 strip：`(fut - spot)/spot * 100`

### 加新交易对
- 不用改代码，只改 `ORDERFLOW_SYMBOLS`：
  ```
  ORDERFLOW_SYMBOLS="spot:BTCUSDT:1,spot:ETHUSDT:0.1,spot:SOLUSDT:0.01,..."
  ```

---

## 附录 A：开发历史

| 阶段 | 主要内容 | 增量代码 |
|---|---|---|
| MVP | WS 采集 + 订单簿同步 + 4 视图 + REST/WS | ~1500 行 |
| 持久化 | Parquet 落盘 + duckdb 查询 + 回放 + 前端 toggle | ~600 行 |
| K 线 & 指标 | K 线视图 + Absorption/Iceberg + Stacked Imbalance + funding + 多交易对网格 | ~970 行 |

合计源码 ~2470 行（代码净行，不含空行注释）。

## 附录 B：调试小贴士

- 后端日志全开：默认 INFO 级别已经够。看 `synced` 行可确认订单簿同步成功
- 前端 WS 收发：浏览器 DevTools → Network → WS → Messages
- 检查信号触发：`curl localhost:8000/api/snapshot/spot/BTCUSDT | jq '.signals'`
- 检查落盘速率：`watch -n 5 'find data -name "*.parquet" | wc -l'`
- 单元测试 signals：见 `analytics/signals.py` 顶部 docstring 的样例输入
