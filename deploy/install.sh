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
# Домен, который ещё не отвечает, — не повод останавливаться. Всё долгое
# (Node, сборка, служба) можно поставить сейчас, а сертификат доделать потом
# одним повторным запуском. Иначе человек ждёт домен, ничего не делая.
DNS_OK=1
if [[ -z "$DOMAIN_IP" ]]; then
  DNS_OK=0
  echo "   Домен пока никуда не ведёт: A-записи нет."
  echo "   Поставлю всё остальное, а сертификат доделаем потом — просто"
  echo "   запусти этот же скрипт ещё раз, когда домен заработает."
  echo
fi

# Свой адрес определяем тремя способами подряд: на разных машинах работает
# разное, а ошибиться тут нельзя — ложный запрет хуже отсутствия проверки.
MY_IP=""
[[ "$DNS_OK" == "1" ]] && MY_IP="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)"
[[ -z "$MY_IP" ]] && MY_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' || true)"
[[ -z "$MY_IP" ]] && MY_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
# Последняя строка с [[ ]] вернёт 1, если адрес уже нашёлся, — а это при set -e
# означает конец скрипта. Поэтому ставим точку, на которой он не спотыкается.
true

if [[ "$DNS_OK" != "1" ]]; then
  : # сверять не с чем
elif [[ -z "$MY_IP" ]]; then
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
  # Если прошлый запуск упал на середине установки пакета, apt остаётся в
  # сломанном состоянии и любая следующая установка падает тоже. Чиним молча.
  dpkg --configure -a >/dev/null 2>&1 || true
  apt-get -f install -y -qq >/dev/null 2>&1 || true

  # Боевой случай: в образе Рег.ру предустановлен Node 12 вместе с libnode-dev.
  # Пакет NodeSource владеет теми же файлами в /usr/include/node, и установка
  # падает на «trying to overwrite /usr/include/node/common.gypi, which is also
  # in package libnode-dev». Поэтому системные пакеты Node сначала убираем —
  # имена версий у libnode разные в разных выпусках Ubuntu, поэтому ищем их
  # по образцу, а не списком.
  OLD_NODE="$(dpkg-query -W -f='${Package}\n' 'nodejs' 'nodejs-doc' 'npm' 'libnode*' 2>/dev/null | grep -v '^$' || true)"
  if [[ -n "$OLD_NODE" ]]; then
    echo "   убираю системный Node: $(echo $OLD_NODE | tr '\n' ' ')"
    apt-get purge -y -qq $OLD_NODE >/dev/null 2>&1 || true
    apt-get autoremove -y -qq >/dev/null 2>&1 || true
  fi

  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

# Проверяем, что получилось: дальше без Node 22 делать нечего, а падать лучше
# здесь с внятным сообщением, чем через минуту на непонятной ошибке сборки.
if ! command -v node >/dev/null || [[ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 22 ]]; then
  echo "Node 22 поставить не удалось. Сейчас: $(command -v node >/dev/null && node -v || echo 'нет вовсе')" >&2
  echo "Посмотри ошибку выше. Чаще всего помогает:" >&2
  echo "    apt-get purge -y nodejs npm 'libnode*' && apt-get autoremove -y" >&2
  echo "    bash deploy/install.sh $DOMAIN" >&2
  exit 1
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
# Правили .env в Блокноте — в конце строк окажется windows-овский возврат
# каретки, и systemd утащит его прямо внутрь токена. Telegram такой токен не
# примет, а ошибка будет выглядеть загадочно: токен на вид правильный.
sed -i 's/\r$//' "$APP_DIR/.env"
chown -R sara:sara "$APP_DIR"
chmod 600 "$APP_DIR/.env"

echo "==> nginx"
mkdir -p /var/www/html
# Сначала всегда ставим конфиг только на 80 порт: до выписки сертификата
# конфиг с HTTPS ссылается на несуществующие файлы, и nginx вообще не стартует.
# Приложение при этом уже доступно по адресу сервера — можно проверить, что
# оно живо, не дожидаясь домена.
cat > /etc/nginx/sites-available/sara <<TMP
server {
    listen 80;
    listen [::]:80;
    server_name $ASCII_DOMAIN _;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    client_max_body_size 25m;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-Host  \$host;
        proxy_set_header Host              \$host;
        proxy_read_timeout 120s;
    }
}
TMP
ln -sf /etc/nginx/sites-available/sara /etc/nginx/sites-enabled/sara
rm -f /etc/nginx/sites-enabled/default
nginx -t >/dev/null && systemctl reload nginx

echo "==> Сертификат Let\'s Encrypt"
CERT_OK=0
if [[ -f "/etc/letsencrypt/live/$ASCII_DOMAIN/fullchain.pem" ]]; then
  echo "   сертификат уже есть"
  CERT_OK=1
elif [[ "$DNS_OK" != "1" ]]; then
  # Нет смысла дёргать Let's Encrypt, если домен не отвечает: попытки
  # ограничены (пять неудач на домен в час), и сжечь их на заведомо
  # безнадёжном запросе — худшее, что можно сделать.
  echo "   пропускаю: домен ещё не отвечает"
elif certbot certonly --webroot -w /var/www/html -d "$ASCII_DOMAIN" \
       --agree-tos --register-unsafely-without-email --non-interactive; then
  CERT_OK=1
else
  echo "   сертификат выписать не вышло — подробности выше"
fi

# Конфиг с HTTPS ставим ТОЛЬКО когда сертификат есть. Иначе nginx упадёт и
# заберёт с собой доступ к приложению по обычному адресу.
if [[ "$CERT_OK" == "1" ]]; then
  # Рабочий конфиг откладываем: если новый не пройдёт проверку, вернём этот.
  # Без этого на диске остаётся сломанный конфиг, и nginx не поднимется при
  # следующем перезапуске — а узнаётся это в самый неподходящий момент.
  cp /etc/nginx/sites-available/sara /etc/nginx/sites-available/sara.working
  sed "s/ДОМЕН/$ASCII_DOMAIN/g" "$SRC_DIR/deploy/nginx.conf" > /etc/nginx/sites-available/sara

  # Директива «http2 on» появилась только в nginx 1.25.1. В Ubuntu 22.04 стоит
  # 1.18, и она валит проверку конфига целиком: «unknown directive http2».
  # Там то же самое пишется флагом в строке listen.
  NGINX_VER="$(nginx -v 2>&1 | sed 's|.*/||; s|[^0-9.].*||')"
  older_than() { [[ "$1" != "$2" ]] && [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" == "$1" ]]; }
  if older_than "$NGINX_VER" "1.25.1"; then
    echo "   nginx $NGINX_VER — пишу http2 по-старому"
    sed -i -e '/^[[:space:]]*http2 on;$/d' -e 's/^\([[:space:]]*listen .*443 ssl\);/\1 http2;/' \
      /etc/nginx/sites-available/sara
  fi

  if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx
    rm -f /etc/nginx/sites-available/sara.working
    echo "   HTTPS включён"
  else
    # Молчать тут нельзя: раньше сообщение «HTTPS включён» печаталось в любом
    # случае, и поломка конфига выглядела как успех.
    echo "   конфиг nginx не прошёл проверку — возвращаю рабочий:" >&2
    nginx -t 2>&1 | sed 's/^/     /' >&2
    mv /etc/nginx/sites-available/sara.working /etc/nginx/sites-available/sara
    nginx -t >/dev/null 2>&1 && systemctl reload nginx
    CERT_OK=0
  fi
fi

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

# Пустым считаем и незаполненный токен, и строку с одними пробелами
TOKENS_LEFT="$(grep -cE '^(BOT_TOKEN|OWNER_ID|YANDEX_API_KEY|YANDEX_FOLDER_ID)=[[:space:]]*$' "$APP_DIR/.env" || true)"

if [[ "$TOKENS_LEFT" != "0" ]]; then
  echo "Осталось вписать секреты:"
  echo
  echo "    nano $APP_DIR/.env"
  echo
  echo "Нужны: BOT_TOKEN, OWNER_ID, MAX_BOT_TOKEN, MAX_OWNER_ID,"
  echo "       YANDEX_API_KEY, YANDEX_FOLDER_ID."
  echo "WEBHOOK_SECRET и MAX_WEBHOOK_SECRET уже сгенерированы."
  echo
  echo "Потом:  systemctl start sara"
  # Служба может уже работать с прошлой установки. Тогда на диске лежит новый
  # код, а в памяти — старый, и /version честно показывает старую метку. Без
  # перезапуска это выглядит так, будто правка не доехала.
  if systemctl is-active --quiet sara; then
    systemctl restart sara
    echo
    echo "(служба уже работала — перезапустил на новом коде)"
  fi
else
  systemctl restart sara
  sleep 2
  if systemctl is-active --quiet sara; then
    echo "Служба запущена."
  else
    echo "Служба не поднялась. Что случилось:  journalctl -u sara -n 50"
  fi
fi

echo
if [[ "$CERT_OK" == "1" ]]; then
  echo "Адрес:  https://$DOMAIN"
  echo "Проверить:  curl https://$DOMAIN/version"
else
  echo "Сертификата пока нет, поэтому HTTPS не работает."
  echo "Приложение уже отвечает по адресу сервера:"
  echo "    curl http://$MY_IP/version"
  echo
  if [[ "$DNS_OK" != "1" ]]; then
    echo "Домен $DOMAIN ещё не отвечает. Как заработает — запусти этот же"
    echo "скрипт ещё раз, он доделает сертификат и включит HTTPS:"
  else
    echo "Домен отвечает, но сертификат не выписался. Разберись с причиной"
    echo "выше и запусти ещё раз:"
  fi
  echo "    bash deploy/install.sh $DOMAIN"
  echo
  echo "Пока сертификата нет, боты работать не будут: и Telegram, и MAX"
  echo "принимают вебхук только по HTTPS."
fi
echo "Журнал:  journalctl -u sara -f"
echo "────────────────────────────────────────────────────"
