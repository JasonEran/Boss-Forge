#!/bin/sh
set -eu

environment_file=${1:-deploy/.env.intranet}
compose_file=${BOSS_FORGE_COMPOSE_FILE:-deploy/compose.intranet.yaml}

if [ ! -f "$environment_file" ]; then
  echo "Environment file not found: $environment_file" >&2
  exit 1
fi

docker info >/dev/null
docker compose --env-file "$environment_file" -f "$compose_file" --profile boss-login config --quiet
resolved_compose=$(docker compose --env-file "$environment_file" -f "$compose_file" --profile boss-login config)

setting() {
  key=$1
  awk -F= -v key="$key" '
    /^[[:space:]]*#/ { next }
    $1 == key { value = substr($0, index($0, "=") + 1) }
    END { gsub(/^[[:space:]]+|[[:space:]]+$/, "", value); print value }
  ' "$environment_file"
}

release_id=$(setting BOSS_FORGE_RELEASE_ID)
if [ -z "$release_id" ] || [ "$release_id" = "unversioned" ] || [ "$release_id" = "CHANGE_ME_RELEASE_ID" ]; then
  echo "BOSS_FORGE_RELEASE_ID must be an immutable release or Git revision." >&2
  exit 1
fi

expected_project=boss-forge-intranet
configured_project=$(setting COMPOSE_PROJECT_NAME)
if [ "${configured_project:-boss-forge-intranet}" != "$expected_project" ]; then
  echo "COMPOSE_PROJECT_NAME must remain $expected_project so existing database and runtime volumes are reused." >&2
  exit 1
fi
resolved_project=$(printf '%s\n' "$resolved_compose" |
  awk '$1 == "name:" { value = $2; gsub(/^"|"$/, "", value); print value; exit }')
if [ "$resolved_project" != "$expected_project" ]; then
  echo "Resolved Compose project is ${resolved_project:-unknown}, expected $expected_project. Clear any conflicting shell override before deployment." >&2
  exit 1
fi

compose_service() {
  printf '%s\n' "$resolved_compose" | awk -v service="$1" '
    $0 == "  " service ":" { inside = 1 }
    inside && /^  [A-Za-z0-9_-]+:$/ && $0 != "  " service ":" { exit }
    inside { print }
  '
}
api_service=$(compose_service api)
boss_login_service=$(compose_service boss-login)
boss_login_remote_only=$(printf '%s\n' "$boss_login_service" |
  awk '$1 == "BOSS_BROWSER_REMOTE_ONLY:" { value = $2; gsub(/^"|"$/, "", value); print value; exit }')
if [ "$boss_login_remote_only" != "1" ]; then
  echo "boss-login must set BOSS_BROWSER_REMOTE_ONLY=1 so a failed CDP probe cannot start a second browser." >&2
  exit 1
fi
if ! printf '%s\n' "$boss_login_service" |
  grep -F -- '--remote-debugging-address=127.0.0.1' >/dev/null; then
  echo "boss-login Chromium remote debugging must remain bound to 127.0.0.1 inside its container." >&2
  exit 1
fi
if printf '%s\n' "$boss_login_service" | grep -Eq '^    ports:'; then
  echo "boss-login must not publish Chromium or any other container port." >&2
  exit 1
fi
for service_and_name in "api:$api_service" "boss-login:$boss_login_service"; do
  service_name=${service_and_name%%:*}
  service_body=${service_and_name#*:}
  if ! printf '%s\n' "$service_body" | grep -F 'source: worker_runtime' >/dev/null ||
     ! printf '%s\n' "$service_body" | grep -F 'target: /var/lib/boss-forge/runtime' >/dev/null; then
    echo "$service_name must mount the shared worker_runtime volume for private browser-control IPC." >&2
    exit 1
  fi
done

if ! printf '%s\n' "$api_service" | awk '
  $1 == "-" && $2 == "type:" { source = ""; target = ""; readonly = "" }
  $1 == "source:" { source = $2 }
  $1 == "target:" { target = $2 }
  $1 == "read_only:" { readonly = $2 }
  source == "boss_cli_data" && target == "/home/node/.boss-cli" && readonly == "true" { found = 1 }
  END { exit !found }
'; then
  echo "api must mount boss_cli_data at /home/node/.boss-cli read-only so saved resume previews remain available." >&2
  exit 1
fi

application_image=$(setting BOSS_FORGE_IMAGE)
case "$application_image" in
  *:"$release_id"|*@sha256:*) ;;
  *)
    echo "BOSS_FORGE_IMAGE must use the release ID as its tag, or an immutable sha256 digest." >&2
    exit 1
    ;;
esac
if ! docker image inspect "$application_image" >/dev/null 2>&1; then
  echo "Immutable application image is not present locally: $application_image. Load the approved image; do not build on the production BOSS host." >&2
  exit 1
fi
image_id=$(docker image inspect --format '{{.Id}}' "$application_image")
image_release_id=$(
  docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$application_image" |
    awk -F= '$1 == "BOSS_FORGE_RELEASE_ID" { value = substr($0, index($0, "=") + 1) } END { print value }'
)
if [ "$image_release_id" != "$release_id" ]; then
  echo "Application image release ID is ${image_release_id:-missing}, expected $release_id. Refusing a mistagged or mismatched image." >&2
  exit 1
fi

configured_control_api_url=$(setting NEXT_PUBLIC_CONTROL_API_URL)
image_control_api_url=$(
  docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$application_image" |
    awk -F= '$1 == "NEXT_PUBLIC_CONTROL_API_URL" { value = substr($0, index($0, "=") + 1) } END { print value }'
)
if [ -n "$configured_control_api_url" ] && [ "$image_control_api_url" != "$configured_control_api_url" ]; then
  echo "Application image public API URL is ${image_control_api_url:-missing}, expected $configured_control_api_url. Rebuild the immutable image with the deployment NEXT_PUBLIC_CONTROL_API_URL." >&2
  exit 1
fi

real_contact=$(setting BOSS_FORGE_REAL_GREET_ENABLED)
case "${real_contact:-0}" in
  0|1) ;;
  *)
    echo "BOSS_FORGE_REAL_GREET_ENABLED must be exactly 0 or 1." >&2
    exit 1
    ;;
esac

contact_dispatch_mode=$(setting BOSS_FORGE_CONTACT_DISPATCH_MODE)
case "${contact_dispatch_mode:-disabled}" in
  disabled|fake)
    if [ "${real_contact:-0}" != "0" ]; then
      echo "Disabled or fake contact mode requires BOSS_FORGE_REAL_GREET_ENABLED=0." >&2
      exit 1
    fi
    ;;
  real)
    if [ "${real_contact:-0}" != "1" ]; then
      echo "BOSS_FORGE_CONTACT_DISPATCH_MODE=real also requires BOSS_FORGE_REAL_GREET_ENABLED=1." >&2
      exit 1
    fi
    preview_signing_key=$(setting BOSS_FORGE_CONTACT_PREVIEW_SIGNING_KEY)
    preview_signing_key_bytes=$(LC_ALL=C printf '%s' "$preview_signing_key" | wc -c | tr -d '[:space:]')
    if [ "$preview_signing_key_bytes" -lt 32 ] || [ "$preview_signing_key" = "CHANGE_ME_CONTACT_PREVIEW_SIGNING_KEY" ]; then
      echo "Real contact requires a deployment-specific BOSS_FORGE_CONTACT_PREVIEW_SIGNING_KEY of at least 32 bytes." >&2
      exit 1
    fi
    ;;
  *)
    echo "BOSS_FORGE_CONTACT_DISPATCH_MODE must be exactly disabled, fake or real." >&2
    exit 1
    ;;
esac

configured_restart_policy=$(setting BOSS_FORGE_BOSS_LOGIN_RESTART_POLICY)
boss_login_restart_policy=${BOSS_FORGE_BOSS_LOGIN_RESTART_POLICY:-${configured_restart_policy:-on-failure}}
case "$boss_login_restart_policy" in
  no|on-failure) ;;
  *)
    echo "BOSS_FORGE_BOSS_LOGIN_RESTART_POLICY must be exactly no or on-failure." >&2
    exit 1
    ;;
esac

configured_m1_mode=$(setting BOSS_FORGE_M1_MODE)
m1_mode=${BOSS_FORGE_M1_MODE:-$configured_m1_mode}
configured_canary_max_resume_attempts=$(setting BOSS_FORGE_CANARY_MAX_RESUME_ATTEMPTS)
canary_max_resume_attempts=${BOSS_FORGE_CANARY_MAX_RESUME_ATTEMPTS:-$configured_canary_max_resume_attempts}
case "${m1_mode:-normal}" in
  normal|collection-only|resume-only) ;;
  *)
    echo "BOSS_FORGE_M1_MODE must be exactly normal, collection-only or resume-only." >&2
    exit 1
    ;;
esac
case "$canary_max_resume_attempts" in
  "") ;;
  [1-9]|1[0-9]|20) ;;
  *)
    echo "BOSS_FORGE_CANARY_MAX_RESUME_ATTEMPTS must be an integer from 1 to 20." >&2
    exit 1
    ;;
esac
if [ "${m1_mode:-normal}" = "collection-only" ] && [ -n "$canary_max_resume_attempts" ]; then
  echo "collection-only cannot set BOSS_FORGE_CANARY_MAX_RESUME_ATTEMPTS." >&2
  exit 1
fi
if { [ "${m1_mode:-normal}" = "collection-only" ] || [ -n "$canary_max_resume_attempts" ]; } && [ "$boss_login_restart_policy" != "no" ]; then
  echo "Controlled M1 canaries require BOSS_FORGE_BOSS_LOGIN_RESTART_POLICY=no so an abnormal exit cannot reset the attempt counter." >&2
  exit 1
fi

for binary_flag in BOSS_FORGE_RESUME_PREVIEW_ENABLED BOSS_RESUME_OCR; do
  binary_value=$(setting "$binary_flag")
  case "${binary_value:-0}" in
    0|1) ;;
    *)
      echo "$binary_flag must be exactly 0 or 1; refusing an ambiguous real-browser setting." >&2
      exit 1
      ;;
  esac
done

bootstrap_password=$(setting BOSS_FORGE_BOOTSTRAP_PASSWORD)
case "$bootstrap_password" in
  ""|CHANGE_ME_BOOTSTRAP_PASSWORD|ChangeMe-BossForge-Internal!)
    echo "BOSS_FORGE_BOOTSTRAP_PASSWORD must be replaced with a strong deployment secret." >&2
    exit 1
    ;;
esac

postgres_password=$(setting BOSS_DB_PASSWORD)
case "$postgres_password" in
  ""|CHANGE_ME_BOSS_DB_PASSWORD|boss_forge)
    echo "BOSS_DB_PASSWORD must be replaced with a deployment-specific secret." >&2
    exit 1
    ;;
esac

browser_profile_volume=$(setting BOSS_BROWSER_PROFILE_VOLUME)
case "$browser_profile_volume" in
  ""|CHANGE_ME_EXISTING_BROWSER_PROFILE_VOLUME)
    echo "BOSS_BROWSER_PROFILE_VOLUME must name the existing persistent browser volume." >&2
    exit 1
    ;;
esac
if ! docker volume inspect "$browser_profile_volume" >/dev/null 2>&1; then
  echo "Configured browser profile volume does not exist: $browser_profile_volume" >&2
  exit 1
fi

boss_cli_data_volume=$(setting BOSS_CLI_DATA_VOLUME)
case "$boss_cli_data_volume" in
  ""|CHANGE_ME_EXISTING_BOSS_CLI_DATA_VOLUME)
    echo "BOSS_CLI_DATA_VOLUME must name the existing persistent boss-cli volume." >&2
    exit 1
    ;;
esac
if ! docker volume inspect "$boss_cli_data_volume" >/dev/null 2>&1; then
  echo "Configured boss-cli data volume does not exist: $boss_cli_data_volume" >&2
  exit 1
fi

memory_kib=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)
swap_kib=$(awk '/^SwapTotal:/ { print $2 }' /proc/meminfo)
total_memory_kib=$((memory_kib + swap_kib))
minimum_physical_memory_kib=$((3 * 1024 * 1024))
minimum_total_memory_kib=$((6 * 1024 * 1024))
if [ "$memory_kib" -lt "$minimum_physical_memory_kib" ]; then
  echo "Insufficient host memory: require at least 3 GiB physical RAM for Chromium." >&2
  exit 1
fi
if [ "$total_memory_kib" -lt "$minimum_total_memory_kib" ]; then
  echo "Insufficient host memory: RAM plus swap must total at least 6 GiB before enabling Chromium." >&2
  exit 1
fi

available_kib=$(df -Pk . | awk 'NR == 2 { print $4 }')
minimum_disk_kib=$((8 * 1024 * 1024))
if [ "$available_kib" -lt "$minimum_disk_kib" ]; then
  echo "Insufficient free disk: at least 8 GiB is required for an audited release and backups." >&2
  exit 1
fi

boss_login_containers=$(docker ps --no-trunc -q \
  --filter 'label=com.docker.compose.service=boss-login')
boss_login_count=$(printf '%s\n' "$boss_login_containers" | awk 'NF { count += 1 } END { print count + 0 }')
if [ "$boss_login_count" -gt 1 ]; then
  echo "Multiple boss-login containers are running; refusing profile access." >&2
  exit 1
fi
for boss_login_container in $boss_login_containers; do
  browser_volume=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/boss-forge/browser"}}{{.Name}}{{end}}{{end}}' "$boss_login_container")
  if [ "$browser_volume" != "$browser_profile_volume" ]; then
    echo "Running boss-login browser mount does not match BOSS_BROWSER_PROFILE_VOLUME; refusing any restart." >&2
    exit 1
  fi
  cli_volume=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/home/node/.boss-cli"}}{{.Name}}{{end}}{{end}}' "$boss_login_container")
  if [ "$cli_volume" != "$boss_cli_data_volume" ]; then
    echo "Running boss-login boss-cli mount does not match BOSS_CLI_DATA_VOLUME; refusing any restart." >&2
    exit 1
  fi
done

legacy_worker_containers=$(docker ps --no-trunc -q \
  --filter 'label=com.docker.compose.service=boss-worker')
if [ -n "$legacy_worker_containers" ]; then
  echo "Legacy boss-worker is running. Stop it cleanly and verify it exited before starting or rebuilding boss-login." >&2
  exit 1
fi

standalone_fake_workers=$(docker ps --no-trunc -q \
  --filter 'label=com.docker.compose.service=contact-worker-fake')
if [ -n "$standalone_fake_workers" ]; then
  echo "Standalone contact-worker-fake is running. Stop it before boss-login so only the supervisor consumes simulated intents." >&2
  exit 1
fi

profile_users=$(docker ps --no-trunc -q --filter "volume=$browser_profile_volume")
for profile_user in $profile_users; do
  case " $boss_login_containers " in
    *" $profile_user "*) ;;
    *)
      echo "Another running container is using BOSS_BROWSER_PROFILE_VOLUME; refusing concurrent profile access." >&2
      exit 1
      ;;
  esac
done

printf '{"ok":true,"releaseId":"%s","imageId":"%s","composeProject":"%s","contactDispatchMode":"%s","realContact":%s,"memoryKiB":%s,"swapKiB":%s,"totalMemoryKiB":%s,"availableDiskKiB":%s}\n' \
  "$release_id" "$image_id" "$resolved_project" \
  "${contact_dispatch_mode:-disabled}" \
  "$( [ "${real_contact:-0}" = "1" ] && printf true || printf false )" \
  "$memory_kib" "$swap_kib" "$total_memory_kib" "$available_kib"
