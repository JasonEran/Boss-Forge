#!/usr/bin/env bash
set -euo pipefail

readonly boss_forge_root="${BOSS_FORGE_ROOT:-/opt/boss-forge}"
readonly env_file="${boss_forge_root}/deploy/.env.intranet"
readonly compose_file="${boss_forge_root}/deploy/compose.intranet.yaml"
readonly certbot_bin="${boss_forge_root}/.certbot/bin/certbot"

"${certbot_bin}" renew --cert-name boss-forge-ip --quiet

cd "${boss_forge_root}"
docker compose \
  --env-file "${env_file}" \
  -f "${compose_file}" \
  --profile https \
  exec -T gateway nginx -s reload
