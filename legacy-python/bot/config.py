"""Загрузка конфигурации из переменных окружения."""
from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


def _require(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(
            f"Не задана обязательная переменная окружения {name}. "
            f"Скопируй .env.example в .env и заполни."
        )
    return value


@dataclass(frozen=True)
class Config:
    bot_token: str
    owner_id: int
    anthropic_api_key: str | None
    anthropic_model: str
    tz: str
    digest_hour: int
    db_path: str
    proxy_url: str | None
    telegram_api_url: str | None
    web_host: str
    web_port: int
    webapp_url: str | None

    @property
    def ai_enabled(self) -> bool:
        return bool(self.anthropic_api_key)


def load_config() -> Config:
    return Config(
        bot_token=_require("BOT_TOKEN"),
        owner_id=int(_require("OWNER_ID")),
        anthropic_api_key=os.getenv("ANTHROPIC_API_KEY") or None,
        anthropic_model=os.getenv("ANTHROPIC_MODEL", "claude-opus-4-8"),
        tz=os.getenv("TZ", "Europe/Moscow"),
        digest_hour=int(os.getenv("DIGEST_HOUR", "9")),
        db_path=os.getenv("DB_PATH", "data/assistant.db"),
        proxy_url=os.getenv("PROXY_URL") or None,
        telegram_api_url=(os.getenv("TELEGRAM_API_URL") or "").rstrip("/") or None,
        web_host=os.getenv("WEB_HOST", "0.0.0.0"),
        # PaaS-платформы передают порт через PORT; иначе WEB_PORT, иначе 8080
        web_port=int(os.getenv("PORT") or os.getenv("WEB_PORT") or "8080"),
        webapp_url=(os.getenv("WEBAPP_URL") or "").rstrip("/") or None,
    )
