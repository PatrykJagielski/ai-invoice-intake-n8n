#!/usr/bin/env bash
# Wdrożenie obiegu dokumentów na Mikrusa (lub dowolny serwer z Dockerem) przez SSH.
#
# Użycie:
#   ./deploy/deploy_mikrus.sh root@srvXX.mikr.us 10XXX            # pierwsze wdrożenie / aktualizacja
#   ./deploy/deploy_mikrus.sh root@srvXX.mikr.us 10XXX --publish  # + publikacja (aktywacja) workflowów
#   ./deploy/deploy_mikrus.sh root@srvXX.mikr.us 10XXX --check    # tylko diagnostyka serwera
#
# Wymaga: logowania SSH kluczem (ssh-copy-id -p PORT root@srvXX.mikr.us) oraz pliku deploy/.env.mikrus
# (wzór: .env.example — ustaw N8N_HOST, N8N_PROTOCOL=https, N8N_SECURE_COOKIE=true, N8N_ENCRYPTION_KEY).
set -euo pipefail

HOST="${1:?Podaj host, np. root@srv12.mikr.us}"
PORT="${2:-22}"
MODE="${3:-}"
REMOTE_DIR="${REMOTE_DIR:-/opt/obieg-dokumentow}"
ENV_FILE="${ENV_FILE:-deploy/.env.mikrus}"
cd "$(dirname "$0")/.."

SSH=(ssh -p "$PORT" -o StrictHostKeyChecking=accept-new -o BatchMode=yes "$HOST")
say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mBŁĄD: %s\033[0m\n' "$*" >&2; exit 1; }

say "Sprawdzam połączenie i serwer ($HOST:$PORT)"
"${SSH[@]}" 'echo "Połączono: $(hostname)"; echo "RAM (MB):"; free -m | sed -n 1,2p; echo "Dysk:"; df -h / | tail -1;
  if command -v docker >/dev/null; then docker --version; docker compose version; else echo "BRAK_DOCKERA"; fi' \
  | tee /tmp/obieg_preflight.txt || die "Brak połączenia SSH kluczem. Uruchom: ssh-copy-id -p $PORT $HOST"

if grep -q BRAK_DOCKERA /tmp/obieg_preflight.txt; then
  die "Na serwerze nie ma Dockera. Zainstaluj go (Mikrus: panel -> Narzędzia albo 'curl -fsSL https://get.docker.com | sh') i uruchom skrypt ponownie."
fi
[[ "$MODE" == "--check" ]] && exit 0

[[ -f "$ENV_FILE" ]] || die "Brak $ENV_FILE — skopiuj .env.example do $ENV_FILE i uzupełnij (domena, klucz szyfrujący, ID folderów)."
grep -qE '^N8N_ENCRYPTION_KEY=.{32,}' "$ENV_FILE" || die "Ustaw N8N_ENCRYPTION_KEY w $ENV_FILE (openssl rand -hex 32)."
C=$(grep -E '^N8N_CONTAINER=' "$ENV_FILE" | cut -d= -f2); C=${C:-obieg-n8n}

say "Buduję workflowy i uruchamiam testy lokalnie"
npm run --silent build >/dev/null
npm test --silent >/dev/null 2>&1 || die "Testy nie przechodzą — przerwano wdrożenie (npm test)."

say "Wysyłam pliki do $REMOTE_DIR"
COPYFILE_DISABLE=1 tar --no-xattrs -czf - docker-compose.yml workflows credentials tests/e2e/check_node_params.cjs \
  | "${SSH[@]}" "mkdir -p '$REMOTE_DIR' && tar xzf - -C '$REMOTE_DIR'"
"${SSH[@]}" "umask 077 && cat > '$REMOTE_DIR/.env'" < "$ENV_FILE"

# Na 1 GB RAM nie mieszczą się dwa procesy n8n naraz (CLI uruchamia pełny n8n) — dlatego import,
# walidacja i publikacja idą w jednorazowym kontenerze przy zatrzymanym głównym n8n (ok. 1–2 min przerwy).
RUN="docker compose run --rm --no-deps -T --name ${C}-cli"
say "Zatrzymuję n8n na czas importu"
"${SSH[@]}" "cd '$REMOTE_DIR' && docker compose pull -q && docker compose stop"

say "Importuję workflowy"
# Credentials importujemy tylko raz — ponowny import nadpisałby sekrety wpisane w UI pustymi wartościami.
"${SSH[@]}" "cd '$REMOTE_DIR' && if [ ! -f .credentials_imported ]; then
    $RUN n8n import:credentials --input=/import/credentials/credentials.json && touch .credentials_imported;
  else echo 'Credentials już zaimportowane — pomijam (sekrety pozostają bez zmian).'; fi"
"${SSH[@]}" "cd '$REMOTE_DIR' && $RUN n8n import:workflow --separate --input=/import/workflows"

say "Sprawdzam parametry węzłów walidatorem n8n"
"${SSH[@]}" "cd '$REMOTE_DIR' && $RUN -v '$REMOTE_DIR/tests/e2e/check_node_params.cjs:/tmp/check.cjs:ro' --entrypoint node n8n /tmp/check.cjs /import/workflows"

if [[ "$MODE" == "--publish" ]]; then
  say "Publikuję (aktywuję) workflowy"
  # 03 i 99 muszą być opublikowane, żeby dało się je wywołać; 02/04 to harmonogramy.
  # 01 (poczta) publikujemy tylko, gdy PUBLISH_EMAIL=1 — czyta i oznacza maile jako przeczytane.
  IDS="ObiegDok99Error0 ObiegDok03Proc00 ObiegDok02Poll00 ObiegDok04Expo00"
  [[ "${PUBLISH_EMAIL:-0}" == "1" ]] && IDS="$IDS ObiegDok01Email0"
  for id in $IDS; do
    "${SSH[@]}" "cd '$REMOTE_DIR' && $RUN n8n publish:workflow --id=$id" | tail -1
  done
fi

say "Uruchamiam n8n"
"${SSH[@]}" "cd '$REMOTE_DIR' && docker compose up -d"
"${SSH[@]}" "for i in \$(seq 1 120); do docker exec $C wget -qO- http://localhost:5678/healthz >/dev/null 2>&1 && exit 0; sleep 3; done; exit 1" \
  || die "n8n nie wystartował — sprawdź: ssh -p $PORT $HOST 'docker logs $C --tail 100'"

say "Stan kontenera"
"${SSH[@]}" "docker ps --filter name=$C --format '{{.Names}}: {{.Status}}'; docker stats $C --no-stream --format 'RAM: {{.MemUsage}}  CPU: {{.CPUPerc}}'"
DOMAIN=$(grep -E '^N8N_HOST=' "$ENV_FILE" | cut -d= -f2)
say "Gotowe. Panel n8n: https://$DOMAIN/"
[[ "$MODE" == "--publish" ]] || echo "Po uzupełnieniu credentials w UI uruchom ponownie z flagą --publish (albo włącz workflowy przełącznikiem w UI)."
