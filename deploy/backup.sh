#!/usr/bin/env bash
# Резервная копия базы.
#
# На Cloudflare базу бэкапил Cloudflare. На своём сервере это наша забота, и
# она важнее всего остального в этой папке: потерять задачи и клиентов нельзя.
#
# Копируем средствами SQLite, а не cp: приложение в этот момент может писать,
# и обычная копия файла получится битой.
set -euo pipefail

DB="${DB_FILE:-/opt/sara/data/assistant.db}"
DEST="${BACKUP_DIR:-/opt/sara/backups}"
KEEP="${KEEP_DAYS:-30}"

mkdir -p "$DEST"
STAMP=$(date +%Y-%m-%d_%H-%M)
OUT="$DEST/assistant_$STAMP.db"

sqlite3 "$DB" ".backup '$OUT'"
gzip -f "$OUT"
echo "копия: $OUT.gz"

# Старые копии убираем, иначе диск кончится незаметно
find "$DEST" -name 'assistant_*.db.gz' -mtime "+$KEEP" -delete
