# 🤝 Telegram-ассистент маркетолога (Cloudflare)

Личный Telegram-бот **+ Mini App** для контроля задач, дедлайнов, клиентов и заметок —
с ИИ-помощником на базе Claude. Работает целиком на **Cloudflare** (без своего сервера):
Workers + D1 + Cron + Static Assets. Хостинг практически бесплатный, деплой — из GitHub.

Заточен под работу с контекстной рекламой (Яндекс Директ, Google Ads), таргетом
(Telegram Ads, VK Реклама, Авито) и клиентскими проектами.

## Возможности

- **📋 Задачи и дедлайны** — создание (пошагово в чате или в Mini App), статусы,
  привязка к клиенту. Дедлайн словами: «завтра», «пятница», «через 3 дня», «15.03 14:00».
- **📲 Mini App** — доска задач прямо внутри Telegram (вкладки Задачи / Клиенты / Заметки).
- **⏰ Напоминания + ☀️ дайджест** — по расписанию через Cron Triggers.
- **👥 Клиенты** — карточки с площадками, бюджетом, задачами.
- **📝 Заметки** — быстрое сохранение через `!`, теги, поиск.
- **🤖 ИИ-помощник (Claude)** — объявления, заголовки, офферы, разбор лендингов, а также голосовой ввод (распознавание — Yandex SpeechKit).
- **🔐 Роли и доступ** — владелец / команда / клиент, подтверждение по кнопке.
- **💬 Канал MAX** — тот же бот в мессенджере MAX (общие задачи и данные с Telegram).

## Архитектура

```
Cloudflare Worker (src/) ── webhook ──▶ Telegram
   ├── src/index.ts   точка входа: webhook, API, статика, cron
   ├── src/bot.ts     логика бота (grammy): команды, кнопки, диалоги
   ├── src/api.ts     API для Mini App + проверка подписи Telegram
   ├── src/db.ts      доступ к базе D1
   ├── src/reports.ts дайджест
   ├── src/ai.ts      Claude (Anthropic) API
   ├── src/speech.ts  распознавание речи (Yandex SpeechKit)
   ├── src/intent.ts  распознавание команд (задачи/встречи/клиенты)
   ├── src/max/       канал MAX (client.ts — Bot API, bot.ts — обработчик)
   └── src/utils.ts   парсинг дат и форматирование
public/index.html     интерфейс Mini App
schema.sql            таблицы базы D1
```

**Стек:** TypeScript, [grammY](https://grammy.dev/), Cloudflare Workers + D1 + Cron.

## Деплой на Cloudflare

Нужен аккаунт [Cloudflare](https://dash.cloudflare.com/) (бесплатный) и токен бота
от [@BotFather](https://t.me/BotFather).

1. **Создай базу D1:** дашборд → Storage & Databases → D1 → Create → имя `assistant-db`.
   Скопируй `database_id` и впиши его в `wrangler.toml` (поле `database_id`).
2. **Применить схему:** в консоли D1 (вкладка Console) выполни содержимое `schema.sql`.
3. **Подключи репозиторий:** Workers & Pages → Create → Import a repository → выбери
   этот репозиторий. Cloudflare соберёт воркер по `wrangler.toml` и будет
   передеплоивать при каждом `git push`.
4. **Задай секреты** (Worker → Settings → Variables and Secrets):
   `BOT_TOKEN`, `OWNER_ID`, `WEBHOOK_SECRET` (любая длинная случайная строка),
   для ИИ — `ANTHROPIC_API_KEY` (секрет, Claude); для голоса — `YANDEX_API_KEY` (секрет) + `YANDEX_FOLDER_ID` (каталог Yandex Cloud, роль `ai.speechkit-stt.user`).
5. **Активируй бота:** открой в браузере `https://<твой-воркер>.workers.dev/init?secret=<WEBHOOK_SECRET>`
   один раз — зарегистрируется webhook, команды и кнопка Mini App.

Готово: в чате — бот, слева от поля ввода — кнопка «📲 Открыть» с доской задач.

### Локальная разработка

```bash
npm install
cp .dev.vars.example .dev.vars   # заполни BOT_TOKEN, OWNER_ID, WEBHOOK_SECRET
npm run db:init:local            # создать таблицы локально
npm run dev                      # wrangler dev
```

## Команды бота

`/start`, `/menu`, `/app`, `/tasks`, `/addtask`, `/clients`, `/addclient`,
`/client <номер>`, `/notes`, `/findnote <слово>`, `/ai <запрос>`, `/digest`,
`/help`, `/users`, `/kick <ID>`. Быстрая заметка — сообщение, начатое с `!`.

## Настройки (wrangler.toml → [vars])

| Переменная | По умолчанию | Что это |
|---|---|---|
| `ANTHROPIC_MODEL` | `claude-sonnet-5` | Модель ИИ Claude |
| `YANDEX_FOLDER_ID` | — | Каталог Yandex Cloud для распознавания голоса (можно секретом) |
| `TZ_OFFSET` | `3` | Смещение часового пояса от UTC (Москва = 3) |
| `DIGEST_HOUR` | `9` | Час утреннего дайджеста |

**Мозги** — Claude (Anthropic): нужен секрет `ANTHROPIC_API_KEY`.
**Голос** — Yandex SpeechKit: нужны `YANDEX_API_KEY` (секрет) и `YANDEX_FOLDER_ID`,
сервисному аккаунту — роль `ai.speechkit-stt.user`.

---

`legacy-python/` — прежняя версия на Python/aiogram (для сервера/VPS). Оставлена как
запасной вариант; основная версия — Cloudflare.
