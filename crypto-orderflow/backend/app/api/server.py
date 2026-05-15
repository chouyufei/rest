from __future__ import annotations

import asyncio
import logging

import orjson
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import ORJSONResponse

from ..collectors import run_all
from ..config import SYMBOLS
from ..state import hub

log = logging.getLogger(__name__)
app = FastAPI(default_response_class=ORJSONResponse, title="Crypto Orderflow")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_collector_task: asyncio.Task | None = None


@app.on_event("startup")
async def _startup() -> None:
    global _collector_task
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    _collector_task = asyncio.create_task(run_all(SYMBOLS))


@app.on_event("shutdown")
async def _shutdown() -> None:
    if _collector_task is not None:
        _collector_task.cancel()


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


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    await ws.accept()
    q = hub.subscribe()
    try:
        # send initial snapshot of all symbols
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
        log.warning("ws err: %s", exc)
    finally:
        hub.unsubscribe(q)
