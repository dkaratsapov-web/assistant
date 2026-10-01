#!/usr/bin/env bash
#
# Перенос данных с Cloudflare D1 на свой сервер.
#
# Это самый важный шаг переезда: без него новый сервер поднимется с пустой
# базой, и все задачи, клиенты и встречи останутся на Cloudflare. Делать его
# надо ПОСЛЕДНИМ — когда сервер уже проверен и отвечает.
#
# Запускать на своей машине (там, где настроен wrangler), а не на сервере:
#
#   bash deploy/migrate-from-d1.sh root@IP-сервера
#
set -euo pipefail

TARGET="${1:-}"
DB_NAME="${D1_NAME:-assistant-db}"
REMOTE_DIR="${REMOTE_DIR:-/opt/sara}"
DUMP="d1-dump-$(date +%Y-%m-%d_%H-%M).sql"

if [[ -z "$TARGET" ]]; then
  echo "Укажи сервер: bash deploy/migrate-from-d1.sh root@1.2.3.4" >&2
  exit 1
fi

echo "==> Выгружаю базу из D1 (это читает боевые данные, ничего не меняя)"
npx wrangler d1 export "$DB_NAME" --remote --output="$DUMP"
echo "    выгружено: $DUMP ($(wc -l < "$DUMP") строк)"

echo "==> Копирую на сервер"
scp "$DUMP" "$TARGET:/tmp/$DUMP"

echo "==> Останавливаю службу, чтобы никто не писал во время переноса"
ssh "$TARGET" "systemctl stop sara || true"

echo "==> Заливаю в SQLite"
# Старую базу не удаляем, а отодвигаем: если что-то пойдёт не так, откат —
# это одна команда mv, а не восстановление из воздуха.
ssh "$TARGET" "
  set -e
  cd $REMOTE_DIR/data
  if [ -f assistant.db ]; then
    mv assistant.db assistant.db.before-import-\$(date +%Y-%m-%d_%H-%M)
  fi
  sqlite3 assistant.db < /tmp/$DUMP
  chown sara:sara assistant.db
  rm -f /tmp/$DUMP
  echo '    таблиц в базе:' \$(sqlite3 assistant.db \"SELECT count(*) FROM sqlite_master WHERE type='table'\")
  echo '    задач:' \$(sqlite3 assistant.db 'SELECT count(*) FROM tasks')
  echo '    клиентов:' \$(sqlite3 assistant.db 'SELECT count(*) FROM clients')
"

echo "==> Поднимаю службу"
ssh "$TARGET" "systemctl start sara && sleep 2 && systemctl is-active sara"

echo
echo "Готово. Проверь, что на месте задачи и клиенты, и только потом"
echo "выключай cron-триггеры воркера — иначе они будут отбирать вебхук обратно."
