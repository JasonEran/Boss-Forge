#!/bin/sh
set -eu

backup_directory=/backups
interval_seconds=${BOSS_FORGE_BACKUP_INTERVAL_SECONDS:-86400}
retention_days=${BOSS_FORGE_BACKUP_RETENTION_DAYS:-14}

case "$interval_seconds" in
  *[!0-9]*|'') echo "BOSS_FORGE_BACKUP_INTERVAL_SECONDS must be a positive integer." >&2; exit 1 ;;
esac
case "$retention_days" in
  *[!0-9]*|'') echo "BOSS_FORGE_BACKUP_RETENTION_DAYS must be a positive integer." >&2; exit 1 ;;
esac
if [ "$interval_seconds" -lt 3600 ] || [ "$retention_days" -lt 1 ]; then
  echo "Backup interval must be at least one hour and retention at least one day." >&2
  exit 1
fi

mkdir -p "$backup_directory"

while true; do
  timestamp=$(date -u +%Y%m%dT%H%M%SZ)
  final_path="$backup_directory/boss-forge-$timestamp.dump"
  temporary_path="$backup_directory/.boss-forge-$timestamp.dump.tmp"

  rm -f -- "$temporary_path"
  if PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
    --host=postgres \
    --username="$POSTGRES_USER" \
    --dbname="$POSTGRES_DB" \
    --format=custom \
    --file="$temporary_path" \
    && pg_restore --list "$temporary_path" >/dev/null; then
    mv -- "$temporary_path" "$final_path"
    printf '{"ok":true,"event":"database.backup.completed","file":"%s"}\n' "$(basename "$final_path")"
    find "$backup_directory" -maxdepth 1 -type f -name 'boss-forge-*.dump' \
      -mtime "+$retention_days" -exec rm -f -- {} +
  else
    rm -f -- "$temporary_path"
    printf '{"ok":false,"event":"database.backup.failed"}\n' >&2
  fi

  sleep "$interval_seconds"
done
