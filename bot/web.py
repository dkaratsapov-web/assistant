"""Веб-сервер Mini App: API к данным бота + отдача интерфейса.

Работает в том же процессе, что и бот (общая база). Авторизация — по подписи
Telegram WebApp initData, так что доступ к данным получают только пользователи,
открывшие приложение из твоего бота.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
from pathlib import Path
from urllib.parse import parse_qsl

from aiohttp import web

from . import db as dbmod
from .config import Config
from .db import Database
from .utils import parse_due

WEBAPP_DIR = Path(__file__).parent / "webapp"


def validate_init_data(init_data: str, bot_token: str, max_age: int = 86400) -> dict | None:
    """Проверяет подпись Telegram WebApp initData. Возвращает данные или None."""
    if not init_data:
        return None
    try:
        parsed = dict(parse_qsl(init_data, strict_parsing=True))
    except ValueError:
        return None
    received_hash = parsed.pop("hash", None)
    if not received_hash:
        return None
    data_check_string = "\n".join(f"{k}={parsed[k]}" for k in sorted(parsed))
    secret_key = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    calc_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(calc_hash, received_hash):
        return None
    # Защита от переигрывания старых initData
    try:
        auth_date = int(parsed.get("auth_date", "0"))
        if max_age and (time.time() - auth_date) > max_age:
            return None
    except ValueError:
        return None
    try:
        user = json.loads(parsed.get("user", "{}"))
    except json.JSONDecodeError:
        return None
    return {"user": user}


@web.middleware
async def auth_middleware(request: web.Request, handler):
    """Пускает к /api/* только с валидным initData и известного пользователя."""
    if not request.path.startswith("/api/"):
        return await handler(request)

    config: Config = request.app["config"]
    db: Database = request.app["db"]
    init_data = request.headers.get("X-Telegram-Init-Data", "")
    data = validate_init_data(init_data, config.bot_token)
    if data is None:
        return web.json_response({"error": "unauthorized"}, status=401)

    user_id = data["user"].get("id")
    user_row = await db.get_user(user_id) if user_id else None
    if user_row is None or user_row["role"] == dbmod.ROLE_PENDING:
        return web.json_response({"error": "no_access"}, status=403)

    request["user_id"] = user_id
    request["role"] = user_row["role"]
    return await handler(request)


# ---------- API ----------

async def api_me(request: web.Request) -> web.Response:
    return web.json_response({"user_id": request["user_id"], "role": request["role"]})


async def api_tasks(request: web.Request) -> web.Response:
    db: Database = request.app["db"]
    role = request["role"]
    assignee = None if role == dbmod.ROLE_OWNER else request["user_id"]
    status_filter = request.query.get("status", "active")
    if status_filter == "done":
        statuses = (dbmod.TASK_DONE,)
    elif status_filter == "all":
        statuses = (dbmod.TASK_OPEN, dbmod.TASK_IN_PROGRESS, dbmod.TASK_DONE)
    else:
        statuses = (dbmod.TASK_OPEN, dbmod.TASK_IN_PROGRESS)

    tasks = await db.list_tasks(statuses=statuses, assignee_id=assignee)
    result = []
    for t in tasks:
        client = await db.get_client(t["client_id"]) if t["client_id"] else None
        result.append({
            "id": t["id"],
            "title": t["title"],
            "description": t["description"],
            "status": t["status"],
            "due_at": t["due_at"],
            "client": client["name"] if client else None,
        })
    return web.json_response({"tasks": result})


async def api_task_status(request: web.Request) -> web.Response:
    db: Database = request.app["db"]
    task_id = int(request.match_info["id"])
    body = await request.json()
    status = body.get("status")
    if status not in (dbmod.TASK_OPEN, dbmod.TASK_IN_PROGRESS, dbmod.TASK_DONE):
        return web.json_response({"error": "bad_status"}, status=400)
    task = await db.get_task(task_id)
    if task is None:
        return web.json_response({"error": "not_found"}, status=404)
    await db.set_task_status(task_id, status)
    return web.json_response({"ok": True})


async def api_task_create(request: web.Request) -> web.Response:
    db: Database = request.app["db"]
    config: Config = request.app["config"]
    body = await request.json()
    title = (body.get("title") or "").strip()
    if not title:
        return web.json_response({"error": "empty_title"}, status=400)
    due_raw = (body.get("due") or "").strip()
    due_at = parse_due(due_raw, config.tz) if due_raw else None
    client_id = body.get("client_id") or None
    task_id = await db.add_task(
        title=title,
        creator_id=request["user_id"],
        assignee_id=request["user_id"],
        client_id=client_id,
        due_at=due_at,
    )
    return web.json_response({"ok": True, "id": task_id})


async def api_task_delete(request: web.Request) -> web.Response:
    db: Database = request.app["db"]
    task_id = int(request.match_info["id"])
    await db.delete_task(task_id)
    return web.json_response({"ok": True})


async def api_clients(request: web.Request) -> web.Response:
    db: Database = request.app["db"]
    clients = await db.list_clients()
    result = [{
        "id": c["id"],
        "name": c["name"],
        "platforms": c["platforms"],
        "status": c["status"],
        "budget": c["budget"],
    } for c in clients]
    return web.json_response({"clients": result})


async def api_notes(request: web.Request) -> web.Response:
    db: Database = request.app["db"]
    notes = await db.list_notes(request["user_id"], limit=50)
    result = [{"id": n["id"], "text": n["text"], "tags": n["tags"]} for n in notes]
    return web.json_response({"notes": result})


async def index(request: web.Request) -> web.Response:
    return web.FileResponse(WEBAPP_DIR / "index.html")


async def health(request: web.Request) -> web.Response:
    return web.json_response({"status": "ok"})


def build_web_app(db: Database, config: Config) -> web.Application:
    app = web.Application(middlewares=[auth_middleware])
    app["db"] = db
    app["config"] = config
    app.add_routes([
        web.get("/", index),
        web.get("/health", health),
        web.get("/api/me", api_me),
        web.get("/api/tasks", api_tasks),
        web.post("/api/tasks", api_task_create),
        web.post("/api/tasks/{id}/status", api_task_status),
        web.delete("/api/tasks/{id}", api_task_delete),
        web.get("/api/clients", api_clients),
        web.get("/api/notes", api_notes),
    ])
    app.router.add_static("/static/", WEBAPP_DIR, name="static")
    return app
