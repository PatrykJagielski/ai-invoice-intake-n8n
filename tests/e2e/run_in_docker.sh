#!/usr/bin/env bash
# Test E2E na prawdziwym n8n (lokalny kontener „n8n” z docker compose):
#  1) walidacja parametrów wszystkich węzłów walidatorem n8n,
#  2) wariant z atrapami usług zewnętrznych: poller 02 -> sub-workflow 03 dla 3 plików
#     (poprawna FV, FV z błędną sumą -> ponowienie Sonnetem -> weryfikacja, plik .docx -> 90_Bledy).
set -euo pipefail
cd "$(dirname "$0")/../.."
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
C=${N8N_CONTAINER:-obieg-n8n}
docker ps --format '{{.Names}}' | grep -qx "$C" || { echo "Uruchom najpierw: docker compose up -d (kontener $C)"; exit 1; }

echo "== 1. Parametry węzłów"
npm run --silent build >/dev/null
docker cp tests/e2e/check_node_params.cjs "$C":/tmp/check.cjs
docker exec "$C" node /tmp/check.cjs /import/workflows

echo "== 2. Przebieg z atrapami"
node tests/e2e/build_mock_variant.mjs "$TMP/mock" >/dev/null
docker exec -u root "$C" rm -rf /tmp/mock
docker cp "$TMP/mock" "$C":/tmp/mock
docker exec -u root "$C" chown -R node /tmp/mock
docker exec "$C" n8n import:workflow --separate --input=/tmp/mock >/dev/null
docker exec -e N8N_RUNNERS_BROKER_PORT=5690 "$C" n8n publish:workflow --id=TestDok03Proc000 >/dev/null 2>&1
run() { docker exec -e N8N_RUNNERS_BROKER_PORT=5690 "$C" n8n execute --id="$1" > "$TMP/$1.txt" 2>&1 || true; }
run TestDok02Poll000; run TestDok03ManF100; run TestDok03ManF200

check() {

node - "$TMP" <<'JS'
const fs = require('fs');
const dir = process.argv[2];
const load = (id) => { const t = fs.readFileSync(`${dir}/${id}.txt`, 'utf8'); return JSON.parse(t.slice(t.indexOf('{'))).data.resultData; };
const out = (rd, n, run = 0) => rd.runData[n][run].data.main.flat().map((i) => i.json);
let fails = 0;
const check = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fails++; };

const poll = load('TestDok02Poll000');
check(!poll.error, 'poller zakończony bez błędu');
check(poll.runData['Przetwórz dokument'].length === 3, 'każdy z 3 plików przetworzony osobno');
check(out(poll, 'Alert: błąd przetwarzania')[0].file === 'notatka.docx', 'plik .docx -> 90_Bledy + alert');

const f1 = load('TestDok03ManF100');
check(out(f1, 'Folder docelowy')[0].targetFolderId === 'FOLDER-2026-09', 'poprawna FV -> nowy folder archiwum 2026-09');
check(out(f1, 'Zapisz w rejestrze')[0].status === 'OK', 'poprawna FV -> wiersz OK w rejestrze');
check(out(f1, 'Zapisz pozycje').length === 4, 'poprawna FV -> 4 pozycje w rejestrze');
check(!f1.runData['Zapytanie – Sonnet 5'], 'poprawna FV -> bez ponawiania');

const f2 = load('TestDok03ManF200');
check(f2.runData['Claude – odczyt dokumentu'].length === 2, 'błędna suma -> ponowny odczyt modelem Sonnet');
const v = out(f2, 'Walidacja matematyczna', 1)[0];
check(v.model === 'claude-sonnet-5' && v.kosztUsd > 0.02, 'koszt obu prób zsumowany');
check(out(f2, 'Zapisz w rejestrze')[0].status === 'DO_WERYFIKACJI', 'błędna suma -> status DO_WERYFIKACJI');
check(/^\[Do weryfikacji\]/.test(out(f2, 'Powiadomienie: do weryfikacji')[0].mail), 'błędna suma -> e-mail z powiadomieniem');
console.log(fails ? `\n${fails} sprawdzeń nie przeszło` : '\nE2E OK');
if (fails) console.log('DIAGNOSTYKA poller:', JSON.stringify(poll.runData['Przetwórz dokument'].map((r) => r.data.main[0].map((i) => i.json.error || 'ok'))));
process.exit(fails ? 1 : 0);
JS
}

# Pierwsze uruchomienie tuż po imporcie zdarza się niestabilne (n8n inicjalizuje sub-workflow) — jedno ponowienie.
if ! check; then
  echo "== Ponawiam przebieg z atrapami"
  run TestDok02Poll000; run TestDok03ManF100; run TestDok03ManF200
  check
fi
