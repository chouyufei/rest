from __future__ import annotations

import asyncio
import logging
from typing import Optional

import orjson
from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import ORJSONResponse

from ..analytics import klines as klines_mod
from ..collectors import run_all, run_funding_loop
from ..config import SYMBOLS
from ..state import hub
from ..storage import HistoryReader, Replayer
from ..storage.writer import storage

log = logging.getLogger(__name__)
app = FastAPI(default_response_class=ORJSONResponse, title="Crypto Orderflow")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_collector_task: asyncio.Task | None = None
_funding_task: asyncio.Task | None = None
_reader = HistoryReader()


@app.on_event("startup")
async def _startup() -> None:
    global _collector_task, _funding_task
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    await storage.start()
    _collector_task = asyncio.create_task(run_all(SYMBOLS))
    _funding_task = asyncio.create_task(run_funding_loop(SYMBOLS))


@app.on_event("shutdown")
async def _shutdown() -> None:
    for t in (_collector_task, _funding_task):
        if t is not None:
            t.cancel()
    await storage.stop()


@app.get("/api/symbols")
async def list_symbols() -> dict:
    return {
        "symbols": [
            {"market": s.spec.market, "symbol": s.spec.symbol, "tick_size": s.spec.tick_size, "ready": s.book.ready}
            for s in hub.symbols.values()
        ]
    }


@app.get("/api/snapshot/{market}/{symbol}")
async def get_snapshot(market: str, symbol: str) -> dict:
    s = hub.get(market, symbol)
    if s is None:
        raise HTTPException(404, "unknown symbol")
    return s.snapshot_full()


# ---- klines ------------------------------------------------------------

@app.get("/api/klines/intervals")
async def kline_intervals() -> dict:
    return {"intervals": klines_mod.supported_intervals()}


@app.get("/api/klines/binance/{market}/{symbol}")
async def klines_binance(market: str, symbol: str,
                          interval: str = Query("1m"),
                          limit: int = Query(500)) -> dict:
    if market not in ("spot", "futures"):
        raise HTTPException(400, "market must be spot|futures")
    try:
        data = await klines_mod.fetch_binance_klines(market, symbol.upper(), interval, limit)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except Exception as exc:
        log.warning("binance klines fail: %r", exc)
        raise HTTPException(502, "upstream error")
    return {"market": market, "symbol": symbol.upper(), "interval": interval, "klines": data}


@app.get("/api/klines/local/{market}/{symbol}")
async def klines_local(market: str, symbol: str,
                        interval: str = Query("1m"),
                        ts_from: Optional[int] = Query(None),
                        ts_to: Optional[int] = Query(None),
                        limit: int = Query(1500)) -> dict:
    try:
        data = klines_mod.aggregate_local(market, symbol.upper(), interval, ts_from, ts_to, limit)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return {"market": market, "symbol": symbol.upper(), "interval": interval, "klines": data}


# ---- history -----------------------------------------------------------

@app.get("/api/history/range/{market}/{symbol}")
async def history_range(market: str, symbol: str) -> dict:
    dates = {
        "trades": _reader.list_dates("trades", market, symbol.upper()),
        "snapshots": _reader.list_dates("snapshots", market, symbol.upper()),
        "diffs": _reader.list_dates("diffs", market, symbol.upper()),
    }
    return {"market": market, "symbol": symbol.upper(), "dates": dates}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    q = hub.subscribe()
    try:
        await ws.send_bytes(orjson.dumps({
            "type": "init",
            "data": {k: s.snapshot_full() for k, s in hub.symbols.items()},
        }))
        while True:
            msg = await q.get()
            await ws.send_bytes(orjson.dumps(msg))
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        log.warning("ws err: %r", exc)
    finally:
        hub.unsubscribe(q)


@app.websocket("/ws/replay")
async def ws_replay(
    ws: WebSocket,
    market: str = Query(...),
    symbol: str = Query(...),
    ts_from: int = Query(..., description="毫秒时间戳"),
    ts_to: int = Query(...),
    speed: float = Query(1.0),
) -> None:
    await ws.accept()
    sym = symbol.upper()
    # tick_size 从配置取
    s = hub.get(market, sym)
    tick = s.spec.tick_size if s is not None else 0.0
    replayer = Replayer(_reader, market, sym, ts_from, ts_to, speed=speed)
    try:
        first = True
        async for evt in replayer.stream():
            # 把 tick_size 注入第一条 init，前端的 footprint 才能正确分桶
            if first and evt.get("type") == "init":
                payload = evt["data"][f"{market}:{sym}"]
                payload["tick_size"] = tick
                first = False
            await ws.send_bytes(orjson.dumps(evt))
        await ws.send_bytes(orjson.dumps({"type": "replay_done"}))
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        log.warning("replay ws err: %r", exc)
