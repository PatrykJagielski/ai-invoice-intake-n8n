# Obieg dokumentów kosztowych — n8n + Claude + Google Drive → Comarch Optima

Automatyczny obieg faktur kosztowych, dokumentów WZ i zamówień:

```
 Skaner / pracownicy w terenie ──┐
 Skrzynka e-mail (01) ───────────┴──► Drive: 00_Wejscie
                                            │  (02, co minutę)
                                            ▼
                                   10_W_trakcie ──► 03 Przetwarzanie dokumentu
                                                     1. odczyt: Claude Haiku 4.5 (PDF / zdjęcie → JSON)
                                                     2. walidacja matematyczna (grosze, bez AI)
                                                        └─ błąd? → ponowny odczyt Claude Sonnet 5
                                                     3a. OK   → nowa nazwa → 30_Archiwum/RRRR-MM
                                                     3b. błąd → SPRAWDZ_… → 20_Do_weryfikacji + e-mail
                                                     4. wiersz + pozycje → arkusz „Rejestr dokumentów”
 04 Eksport (codziennie 16:00 / ręcznie) ◄──────────┘
    rejestr (OK / ZATWIERDZONY) → XML rejestru zakupów Optimy + CSV nagłówków i pozycji → 40_Eksport_Optima
 99 Obsługa błędów → e-mail z linkiem do wykonania; plik, którego nie da się przetworzyć → 90_Bledy
```

**Weryfikacja poprawności jest deterministyczna.** Model AI tylko *przepisuje* wartości z dokumentu. Czy sumy się zgadzają, sprawdza zwykły kod na liczbach całkowitych (groszach). Sprawdzane są:

- czy **suma pozycji netto zgadza się z podsumowaniem** dokumentu;
- tabela VAT wg stawek: suma pozycji w każdej stawce, VAT = netto × stawka, netto + VAT = brutto;
- na pozycjach: ilość × cena = wartość netto oraz netto + VAT = brutto;
- NIP (suma kontrolna), wymagane pola zależnie od typu dokumentu i poprawność dat;
- **duplikaty** (ten sam NIP i numer już jest w rejestrze);
- ostrzeżenia bez blokowania dokumentu: waluta obca, kontrahent zagraniczny, inny nabywca niż nasz NIP, „do zapłaty” ≠ brutto.

Tolerancja zaokrągleń domyślnie wynosi 2 gr na pozycji i 5 gr na dokumencie (ustawiasz ją w `.env`).

---

## Koszty

| Pozycja | Koszt |
|---|---|
| n8n (self-hosted) | 0 zł, bez opłat za wykonania |
| Serwer Mikrus 2.1 (1 GB RAM) | abonament roczny Mikrusa |
| Claude Haiku 4.5 ($1 / $5 za 1 mln tokenów) | ok. **1–3 gr za stronę**; przy 500 dok./mies. to kilka–kilkanaście zł |
| Ponowny odczyt Sonnet 5 (tylko przy rozbieżnościach) | ok. 2× koszt Haiku, dotyczy małej części dokumentów |
| Google Drive / Sheets / Gmail | w ramach obecnego konta |

**Dlaczego n8n zamiast Make:** jeden dokument to ok. 20 operacji. Przy 500 dokumentach miesięcznie daje to ok. 10 tys. operacji, co w Make oznacza płatny plan rosnący z wolumenem. Tutaj koszt stały to tylko serwer. Dodatkowo logika walidacji jest zwykłym, przetestowanym kodem w repozytorium (`src/`), a nie klikanymi modułami.

Na lokalnym teście kontener n8n zajmował ok. 335 MB RAM po przetworzeniu dokumentów (limit w `docker-compose.yml`: 850 MB).

---

## Struktura repozytorium

| Ścieżka | Zawartość |
|---|---|
| `src/extraction.js` | prompt, schemat JSON (structured outputs), budowa zapytania do Claude |
| `src/validate.js` | walidacja matematyczna i formalna (**serce procesu**) |
| `src/filename.js` | schemat nazw plików (`{data}_{typ}_{nip}_{numer}` itd.) |
| `src/optima_export.js` | wiersze rejestru, CSV, XML dla Optimy (mapowanie w jednym miejscu) |
| `scripts/build_workflows.mjs` | generuje `workflows/*.json` i wkleja do nich kod z `src/` |
| `workflows/` | gotowe workflowy do importu do n8n (wygenerowane — nie edytuj ręcznie) |
| `credentials/credentials.json` | puste szablony credentials (bez sekretów) |
| `scripts/try_extraction.mjs` | test odczytu prawdziwym Claude na Twoich plikach |
| `samples/generate_samples.py` | generator dokumentów testowych (poprawne i z celowymi błędami) |
| `tests/` | testy jednostkowe (`npm test`) i E2E na prawdziwym n8n (`npm run test:e2e`) |
| `deploy/deploy_mikrus.sh` | wdrożenie na serwer przez SSH |
| `docker-compose.yml`, `.env.example` | uruchomienie n8n (lokalnie i na Mikrusie) |

Workflowy:

| # | Nazwa | Uruchamianie |
|---|---|---|
| 00 | Instalacja — foldery Drive i arkusz rejestru | raz, ręcznie |
| 01 | Poczta → folder wejściowy | nowe maile (IMAP) |
| 02 | Skrzynka wejściowa | co minutę |
| 03 | Przetwarzanie dokumentu | wywoływany przez 02 dla każdego pliku |
| 04 | Eksport do Comarch Optima | codziennie 16:00 + ręcznie |
| 99 | Obsługa błędów | przy błędzie dowolnego workflowu |

---

## 1. Szybki start lokalnie

Wymagane: Docker, Node.js ≥ 20, Python 3 (tylko do generowania dokumentów testowych).

```bash
cp .env.example .env
```

Wpisz do `.env` wartość `N8N_ENCRYPTION_KEY`, np. wygenerowaną tak:

```bash
openssl rand -hex 32
```

```bash
docker compose up -d
```

```bash
docker exec n8n n8n import:credentials --input=/import/credentials/credentials.json
```

```bash
docker exec n8n n8n import:workflow --separate --input=/import/workflows
```

Otwórz <http://localhost:5678> i załóż konto właściciela instancji.

Testy:

```bash
npm install && npm test
```

```bash
npm run test:e2e
```

`test:e2e` uruchamia workflowy 02 i 03 w działającym kontenerze n8n. Usługi zewnętrzne są tam atrapami, a sprawdzane jest m.in. ponowienie odczytu modelem Sonnet, trafienie do weryfikacji i obsługa nieobsługiwanego pliku.

## 2. Test odczytu na prawdziwych dokumentach (przed podłączeniem Google)

```bash
python3 -m venv .venv && .venv/bin/pip install reportlab pillow && .venv/bin/python samples/generate_samples.py
```

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

```bash
npm run try-extraction
```

Możesz podać też własne skany: `npm run try-extraction -- ~/Downloads/faktura.pdf`. Skrypt używa **tego samego** promptu, schematu i walidacji co n8n. Pokazuje odczytane dane, nową nazwę pliku, wykryte rozbieżności i koszt. To najszybszy sposób, żeby ocenić jakość odczytu na Waszych prawdziwych dokumentach.

## 3. Konto Google (Drive + Sheets) — jednorazowo

1. <https://console.cloud.google.com> → nowy projekt, np. „Obieg dokumentów”.
2. **APIs & Services → Library**: włącz *Google Drive API* i *Google Sheets API*.
3. **OAuth consent screen**:
   - typ *Internal*, jeśli macie Google Workspace, albo *External* + dodaj siebie jako test user;
   - dla *External* przełącz aplikację na **In production**. W trybie *Testing* Google unieważnia tokeny po 7 dniach.
4. **Credentials → Create credentials → OAuth client ID** → *Web application*.
   Authorized redirect URI: `https://TWOJA-DOMENA/rest/oauth2-credential/callback` (lokalnie `http://localhost:5678/rest/oauth2-credential/callback`).
5. W n8n: **Overview → Credentials**:
   - „Google Drive – obieg dokumentów”: wklej Client ID i Secret, a potem **Sign in with Google**;
   - „Google Sheets – obieg dokumentów”: to samo.

## 4. Pozostałe credentials w n8n

| Credential | Co wpisać |
|---|---|
| **Anthropic (Claude)** | klucz API z <https://console.anthropic.com> (warto ustawić miesięczny limit wydatków) |
| **Skrzynka faktur (IMAP)** | adres skrzynki, na którą przychodzą faktury, i **hasło aplikacji** Gmaila (Konto Google → Bezpieczeństwo → Hasła aplikacji; wymaga 2FA). Host `imap.gmail.com` jest już wpisany. |
| **Powiadomienia (SMTP)** | konto, z którego idą powiadomienia (może być to samo) i hasło aplikacji; host `smtp.gmail.com:465` |

Sekretów nie wpisuj do `.env` ani do repozytorium. Trzymaj je wyłącznie w credentials n8n, gdzie są szyfrowane kluczem `N8N_ENCRYPTION_KEY`.

## 5. Foldery i arkusz rejestru

1. Otwórz workflow **00 Instalacja** i kliknij **Execute workflow**. Na Twoim Drive powstanie:
   - folder `Obieg dokumentów/` z podfolderami `00_Wejscie`, `10_W_trakcie`, `20_Do_weryfikacji`, `30_Archiwum`, `40_Eksport_Optima`, `90_Bledy`;
   - arkusz „Rejestr dokumentów – obieg” z zakładkami *Dokumenty* i *Pozycje*, listą statusów i kolorowaniem.
2. Ostatni węzeł („Fragment .env do skopiowania”) zwraca gotowe linie `DRIVE_FOLDER_…=` i `SHEET_REJESTR_ID=`. Wklej je do `.env` i uzupełnij `NOTIFY_EMAIL_*` oraz `NIP_FIRMY`.
3. Zastosuj zmiany:

   ```bash
   docker compose up -d
   ```

4. Ustaw skaner i aplikację terenową (np. Google Drive na telefonie → skanuj dokument), żeby zapisywały pliki do `00_Wejscie`.

## 6. Włączenie automatu

W n8n opublikuj/aktywuj workflowy w tej kolejności: **99 → 03 → 02 → 04 → 01**. Na serwerze możesz to zrobić za pomocą `deploy_mikrus.sh … --publish`. Workflow 03 musi być opublikowany, bo inaczej 02 nie może go wywołać.

Test: wrzuć do `00_Wejscie` pliki z `samples/out/`. Po około minucie powinno być:

- `01`, `04`, `05`, `06` → `30_Archiwum/2026-09/` z nowymi nazwami i wierszami `OK` w rejestrze;
- `02` (zła suma), `03` (zły NIP) → `20_Do_weryfikacji/SPRAWDZ_…` i e-mail z konkretną rozbieżnością, np. „Suma netto pozycji 1 797,00 ≠ netto w podsumowaniu 1 761,00”;
- ponowne wrzucenie `01` → weryfikacja, bo to duplikat.

---

## 7. Wdrożenie na Mikrusa 2.1

1. **Dostęp SSH kluczem** (jednorazowo, hasło z maila powitalnego Mikrusa):

   ```bash
   ssh-copy-id -p 10XXX root@srvXX.mikr.us
   ```

2. **Diagnostyka serwera** (RAM, dysk, Docker):

   ```bash
   ./deploy/deploy_mikrus.sh root@srvXX.mikr.us 10XXX --check
   ```

   Jeśli brakuje Dockera, zainstaluj go na serwerze:

   ```bash
   curl -fsSL https://get.docker.com | sh
   ```

3. **Domena z HTTPS** (potrzebna do logowania Google OAuth): w panelu Mikrusa przypisz darmową subdomenę do portu n8n (`N8N_HOST_PORT`). Alternatywą jest własna domena przez Cloudflare albo Cloudflare Tunnel.
4. **Konfiguracja produkcyjna:**

   ```bash
   cp .env.example deploy/.env.mikrus
   ```

   W `deploy/.env.mikrus` ustaw:
   - `N8N_HOST=twoja.subdomena`, `N8N_PROTOCOL=https`, `N8N_SECURE_COOKIE=true`;
   - `WEBHOOK_URL=https://twoja.subdomena/`, `N8N_EDITOR_BASE_URL=https://twoja.subdomena/`, `N8N_PROXY_HOPS=1`;
   - `N8N_ENCRYPTION_KEY` (nowy, zapisz go w menedżerze haseł — bez niego credentials są nie do odzyskania);
   - pozostałe wartości jak lokalnie.
5. **Wdrożenie:**

   ```bash
   ./deploy/deploy_mikrus.sh root@srvXX.mikr.us 10XXX
   ```

   Skrypt kolejno:
   - uruchamia testy lokalnie;
   - wysyła pliki i startuje kontener;
   - importuje workflowy i (tylko za pierwszym razem) szablony credentials;
   - sprawdza parametry węzłów walidatorem n8n.
6. W przeglądarce: `https://twoja.subdomena` → konto właściciela → credentials (punkty 3–4) → workflow 00 (punkt 5). Wpisz ID folderów do `deploy/.env.mikrus`, a potem:

   ```bash
   ./deploy/deploy_mikrus.sh root@srvXX.mikr.us 10XXX --publish
   ```

**Aktualizacje:** zmieniasz `src/`, uruchamiasz `npm test`, a potem `deploy_mikrus.sh … --publish`. Import nadpisuje workflowy o tych samych ID, więc zmian robionych ręcznie w UI nie trzymaj tylko w n8n — przenieś je do `scripts/build_workflows.mjs`.

**Kopia zapasowa:** wolumen `n8n_data` (baza SQLite + zaszyfrowane credentials) i plik `.env`. Rejestr i pliki są na Google Drive.

---

## 8. Praca na co dzień

- **Do weryfikacji** (e-mail + folder `20_Do_weryfikacji`):
  1. otwórz plik i arkusz;
  2. popraw dane w zakładkach *Dokumenty*/*Pozycje*. Jeśli zmieniasz kwoty, wyczyść kolumnę `vat_json`, a tabela VAT przeliczy się z pozycji;
  3. ustaw status **ZATWIERDZONY** albo **ODRZUCONY**;
  4. plik możesz przenieść ręcznie do archiwum.
- **Eksport do Optimy** — codziennie o 16:00 albo ręcznie (workflow 04 → *Execute workflow*). W `40_Eksport_Optima` pojawiają się:
  - `optima_rejestr_zakupu_*.xml` — faktury i korekty do rejestru zakupów VAT (format „praca rozproszona”);
  - `dokumenty_*.csv`, `pozycje_*.csv` — wszystkie dokumenty (także WZ i zamówienia) z pozycjami towarowymi (UTF-8 z BOM, separator `;`, przecinek dziesiętny).
  Wyeksportowane wiersze dostają datę w kolumnie `eksport`, więc nie trafią do eksportu drugi raz.
- **Błędy techniczne** (nieobsługiwany format, awaria API): plik trafia do `90_Bledy` + e-mail. Po wyjaśnieniu przenieś go z powrotem do `00_Wejscie`.

### Format XML dla Optimy — do potwierdzenia

Struktura XML to szkic formatu wymiany Optimy (`ROOT/REJESTRY_ZAKUPU_VAT/REJESTR_ZAKUPU_VAT`, pozycje wg stawek VAT). Comarch nie publikuje pełnej specyfikacji, a szczegóły zależą od wersji programu. Przed pierwszym importem produkcyjnym:

1. W Optimie wyeksportuj 1–2 faktury zakupu z rejestru VAT (*Narzędzia → Praca rozproszona → Eksport*).
2. Przekaż mi ten plik. Dopasuję `OPTIMA_XML_MAPPING` / `buildOptimaXml` w `src/optima_export.js` 1:1 (akronim kontrahenta, kategorie, kolumna KPR, płatności).
3. Import testowy zrób najpierw na kopii bazy.

Pozycje towarowe (FZ/PZ w module Handel) można importować z CSV `pozycje_*.csv` lub w kolejnym kroku przez dedykowany format dokumentów handlowych, po otrzymaniu próbki z Waszej Optimy.

---

## Uwagi i dalszy rozwój

- **KSeF:** od 2026 r. faktury krajowe od polskich dostawców są w KSeF, a Optima pobiera je natywnie. Ten obieg jest najbardziej wartościowy dla WZ, zamówień, faktur zagranicznych i paragonów oraz jako kontrola (np. dopasowanie WZ ↔ faktura z KSeF, co jest naturalnym kolejnym krokiem).
- **Formaty:** PDF, JPG, PNG, WEBP. Zdjęcia są zmniejszane do 2000 px (limit API 5 MB, niższy koszt). HEIC z iPhone'a trzeba zapisać jako JPG (ustawienie aparatu „Najbardziej zgodne”).
- **Dyski współdzielone (Shared Drives):** workflowy zakładają „Mój dysk”. Dla dysku współdzielonego trzeba zmienić pole *Drive* w węzłach Google Drive.
- **Dane osobowe/RODO:** dokumenty są wysyłane do API Anthropic (bez trenowania modeli na danych API). Uwzględnij to w rejestrze czynności przetwarzania.
