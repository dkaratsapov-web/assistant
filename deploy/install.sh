#!/usr/bin/env bash
#
# Установка Сары на свой сервер (Ubuntu/Debian). Запускать от root.
#
#   bash deploy/install.sh ваш-домен.ру
#
# Что делает: ставит Node, nginx и certbot, заводит отдельного пользователя,
# раскладывает приложение в /opt/sara, выписывает сертификат, поднимает службу
# и ставит ежедневный бэкап базы.
#
# Скрипт можно запускать повторно: он ничего не ломает, а догоняет недостающее.
# Секреты не трогает — .env заполняется руками один раз.
set -euo pipefail

DOMAIN="${1:-}"
APP_DIR=/opt/sara
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "$DOMAIN" ]]; then
  echo "Укажи домен: bash deploy/install.sh имя-вашего-домена.ру" >&2
  exit 1
fi
# Аргумент проверяем первым делом. Иначе человек ждёт установки пакетов,
# чтобы узнать, что домен не тот: именно так и вышло в первый раз — подпись из
# инструкции подставили буквально.
case "$DOMAIN" in
  ваш-домен*|имя-вашего-домена*|ДОМЕН|example.com|domain.ru)
    echo "«$DOMAIN» — это подпись из инструкции, а не домен." >&2
    echo "Подставь свой: bash deploy/install.sh sara.мойсайт.ру" >&2
    exit 1 ;;
esac
if [[ ! "$DOMAIN" =~ ^[A-Za-zА-Яа-я0-9.-]+\.[A-Za-zА-Яа-я]{2,}$ ]]; then
  echo "«$DOMAIN» не похож на домен. Нужно вида sara.мойсайт.ру" >&2
  exit 1
fi

if [[ $EUID -ne 0 ]]; then
  echo "Нужны права root: sudo bash deploy/install.sh $DOMAIN" >&2
  exit 1
fi

echo "==> Системные пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg nginx certbot python3-certbot-nginx sqlite3 git idn2

echo "==> Проверяю домен $DOMAIN"
# Стоит после установки пакетов нарочно: кириллический домен без idn2 не
# перевести в вид, который понимает DNS, а свой адрес без curl не узнать.
# Пакеты ставятся полминуты, а вот Node и сборка — минуты, и до них ошибку
# домена надо поймать.
ASCII_DOMAIN="$DOMAIN"
if command -v idn2 >/dev/null 2>&1; then
  ASCII_DOMAIN="$(idn2 "$DOMAIN" 2>/dev/null || echo "$DOMAIN")"
fi

# «|| true» обязателен: вверху стоит pipefail, а getent возвращает 2, когда
# имя не найдено, и скрипт молча умирал ровно там, где должен был объяснить,
# что A-записи нет.
DOMAIN_IP="$(getent ahostsv4 "$ASCII_DOMAIN" 2>/dev/null | awk 'NR==1{print $1}' || true)"
if [[ -z "$DOMAIN_IP" ]]; then
  echo "   Домен никуда не ведёт: A-записи нет." >&2
  echo "   В панели регистратора добавь A-запись $DOMAIN на адрес этого сервера" >&2
  echo "   и подожди несколько минут — DNS расходится не мгновенно." >&2
  exit 1
fi

# Свой адрес определяем тремя способами подряд: на разных машинах работает
# разное, а ошибиться тут нельзя — ложный запрет хуже отсутствия проверки.
MY_IP="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)"
[[ -z "$MY_IP" ]] && MY_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' || true)"
[[ -z "$MY_IP" ]] && MY_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
# Последняя строка с [[ ]] вернёт 1, если адрес уже нашёлся, — а это при set -e
# означает конец скрипта. Поэтому ставим точку, на которой он не спотыкается.
true

if [[ -z "$MY_IP" ]]; then
  echo "   Свой адрес определить не вышло — проверю домен выпуском сертификата."
elif [[ "$DOMAIN_IP" == "$MY_IP" ]]; then
  echo "   $DOMAIN → $MY_IP, всё верно"
else
  # Сервер может стоять за NAT, и тогда расхождение законно. Поэтому
  # предупреждаем, но не запрещаем.
  echo
  echo "   ВНИМАНИЕ: домен ведёт на $DOMAIN_IP, а этот сервер видит себя как $MY_IP."
  echo "   Если сервер за NAT — так и должно быть, продолжаем."
  echo "   Если нет — сертификат не выпишется, поправь A-запись у регистратора."
  echo "   Остановить: Ctrl+C. Продолжу через 10 секунд."
  sleep 10
fi


echo "==> Память"
# На тарифах с 1 ГБ сборка (npm ci + esbuild) упирается в память и процесс
# убивает OOM — причём на середине установки, оставляя её недоделанной.
# Подкачка стоит дёшево и снимает вопрос. Если своп уже есть, не трогаем.
TOTAL_MB=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
SWAP_MB=$(awk '/SwapTotal/{print int($2/1024)}' /proc/meminfo)
echo "   памяти ${TOTAL_MB} МБ, подкачки ${SWAP_MB} МБ"
if [[ "$TOTAL_MB" -lt 2048 && "$SWAP_MB" -lt 512 ]]; then
  if [[ ! -f /swapfile ]]; then
    echo "   добавляю 2 ГБ подкачки"
    fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  else
    swapon /swapfile 2>/dev/null || true
  fi
fi

echo "==> Node.js 22"
# node:sqlite, на котором держится база, появился в Node 22. Системный пакет
# в Debian/Ubuntu обычно старее, поэтому ставим из репозитория NodeSource.
if ! command -v node >/dev/null || [[ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
node -v

echo "==> Пользователь и каталоги"
id -u sara >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin sara
mkdir -p "$APP_DIR"/{data,backups}

echo "==> Сборка приложения"
cd "$SRC_DIR"
# Ставим и dev-зависимости: сборка идёт esbuild'ом, а он именно там. Пытаться
# обойтись --omit=dev и доставлять esbuild отдельно — лишний шаг, который
# ломается первым.
npm ci --no-audit --no-fund
npm run build:server

echo "==> Раскладка в $APP_DIR"
install -d -o sara -g sara "$APP_DIR/dist" "$APP_DIR/public" "$APP_DIR/data" "$APP_DIR/backups"
cp -r dist/server.mjs "$APP_DIR/dist/"
cp -r public/. "$APP_DIR/public/"
cp schema.sql "$APP_DIR/"
cp deploy/backup.sh "$APP_DIR/"
chmod +x "$APP_DIR/backup.sh"

# .env создаём только если его нет: повторный запуск не должен стирать секреты
if [[ ! -f "$APP_DIR/.env" ]]; then
  cat > "$APP_DIR/.env" <<ENVFILE
# Секреты. Файл читают только root и служба. В git он не попадает.
PUBLIC_HOST=$DOMAIN
TZ_OFFSET=3
DIGEST_HOUR=9

BOT_TOKEN=
OWNER_ID=
WEBHOOK_SECRET=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)

MAX_BOT_TOKEN=
MAX_OWNER_ID=
MAX_WEBHOOK_SECRET=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)

YANDEX_API_KEY=
YANDEX_FOLDER_ID=
YANDEX_GPT_MODEL=yandexgpt/latest
YANDEX_GPT_ROUTER_MODEL=yandexgpt-lite/latest
ENVFILE
  echo "   создан $APP_DIR/.env — его нужно заполнить"
else
  # Домен мог смениться — он не секрет, его обновляем
  sed -i "s|^PUBLIC_HOST=.*|PUBLIC_HOST=$DOMAIN|" "$APP_DIR/.env"
  echo "   $APP_DIR/.env уже есть, секреты не трогаю"
fi
chown -R sara:sara "$APP_DIR"
chmod 600 "$APP_DIR/.env"

echo "==> nginx"
sed "s/ДОМЕН/$ASCII_DOMAIN/g" deploy/nginx.conf > /etc/nginx/sites-available/sara
ln -sf /etc/nginx/sites-available/sara /etc/nginx/sites-enabled/sara
rm -f /etc/nginx/sites-enabled/default

echo "==> Сертификат Let's Encrypt"
# До выписки сертификата конфиг ссылается на несуществующие файлы и nginx не
# стартует. Поэтому сначала поднимаем временный сервер только на 80 порту.
if [[ ! -f "/etc/letsencrypt/live/$ASCII_DOMAIN/fullchain.pem" ]]; then
  cat > /etc/nginx/sites-available/sara <<TMP
server {
    listen 80;
    server_name $ASCII_DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 200 'ставлю сертификат'; add_header content-type text/plain; }
}
TMP
  mkdir -p /var/www/html
  nginx -t && systemctl reload nginx
  certbot certonly --webroot -w /var/www/html -d "$ASCII_DOMAIN" --agree-tos --register-unsafely-without-email --non-interactive
  sed "s/ДОМЕН/$ASCII_DOMAIN/g" "$SRC_DIR/deploy/nginx.conf" > /etc/nginx/sites-available/sara
fi
nginx -t && systemctl reload nginx

echo "==> Служба"
cp deploy/sara.service /etc/systemd/system/sara.service
systemctl daemon-reload
systemctl enable sara >/dev/null

echo "==> Ежедневная копия базы в 4 утра"
cat > /etc/cron.d/sara-backup <<CRON
0 4 * * * sara DB_FILE=$APP_DIR/data/assistant.db BACKUP_DIR=$APP_DIR/backups $APP_DIR/backup.sh >/dev/null 2>&1
CRON

echo
echo "────────────────────────────────────────────────────"
if grep -q '^BOT_TOKEN=$' "$APP_DIR/.env"; then
  echo "Почти всё. Осталось вписать секреты:"
  echo
  echo "    nano $APP_DIR/.env"
  echo
  echo "Нужны: BOT_TOKEN, OWNER_ID, MAX_BOT_TOKEN, MAX_OWNER_ID,"
  echo "       YANDEX_API_KEY, YANDEX_FOLDER_ID."
  echo "WEBHOOK_SECRET и MAX_WEBHOOK_SECRET уже сгенерированы."
  echo
  echo "Потом запустить:  systemctl start sara"
else
  systemctl restart sara
  echo "Запущено. Проверка:"
  echo "    curl https://$DOMAIN/version"
  echo "    journalctl -u sara -f"
fi
echo "────────────────────────────────────────────────────"
