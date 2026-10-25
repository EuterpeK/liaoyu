#!/usr/bin/env bash
# 宿主机 crontab：0 4 * * * /opt/liaoyu/deploy/backup.sh >> /var/log/liaoyu-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")"
set -a
# shellcheck disable=SC1091
source ./.env
set +a
: "${COS_BUCKET:?请在 deploy/.env 设置 COS_BUCKET}"

DIR=/var/backups/liaoyu
mkdir -p "$DIR"
FILE="$DIR/liaoyu-$(date +%Y%m%d-%H%M%S).dump"

docker compose exec -T postgres pg_dump -U liaoyu -d liaoyu -Fc > "$FILE"
test -s "$FILE"
coscli cp "$FILE" "cos://${COS_BUCKET}/liaoyu/$(basename "$FILE")"
find "$DIR" -name 'liaoyu-*.dump' -mtime +7 -delete
echo "[$(date '+%F %T')] 备份完成 $FILE"
