#!/usr/bin/env node
// Generuje workflowy n8n (workflows/*.json) i puste szablony credentials (credentials/credentials.json).
// Logika biznesowa jest w src/*.js i jest wklejana do węzłów Code — edytuj src/, potem `npm run build`.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Stałe identyfikatory — dzięki nim workflowy odwołują się do siebie i do credentials po imporcie.
// ---------------------------------------------------------------------------
export const WF_IDS = {
  setup: 'ObiegDok00Setup0',
  email: 'ObiegDok01Email0',
  poll: 'ObiegDok02Poll00',
  process: 'ObiegDok03Proc00',
  export: 'ObiegDok04Expo00',
  error: 'ObiegDok99Error0',
};

const CRED = {
  anthropic: { anthropicApi: { id: 'CredAnthropic001', name: 'Anthropic (Claude)' } },
  drive: { googleDriveOAuth2Api: { id: 'CredGDrive000001', name: 'Google Drive – obieg dokumentów' } },
  sheets: { googleSheetsOAuth2Api: { id: 'CredGSheets00001', name: 'Google Sheets – obieg dokumentów' } },
  imap: { imap: { id: 'CredImap00000001', name: 'Skrzynka faktur (IMAP)' } },
  smtp: { smtp: { id: 'CredSmtp00000001', name: 'Powiadomienia (SMTP)' } },
};

const CREDENTIAL_SHELLS = [
  { ...CRED.anthropic.anthropicApi, type: 'anthropicApi', data: { apiKey: '', url: 'https://api.anthropic.com' } },
  { ...CRED.drive.googleDriveOAuth2Api, type: 'googleDriveOAuth2Api', data: { clientId: '', clientSecret: '' } },
  { ...CRED.sheets.googleSheetsOAuth2Api, type: 'googleSheetsOAuth2Api', data: { clientId: '', clientSecret: '' } },
  { ...CRED.imap.imap, type: 'imap', data: { user: '', password: '', host: 'imap.gmail.com', port: 993, secure: true } },
  { ...CRED.smtp.smtp, type: 'smtp', data: { user: '', password: '', host: 'smtp.gmail.com', port: 465, secure: true } },
];

// ---------------------------------------------------------------------------
// Pomocnicze
// ---------------------------------------------------------------------------
function include(...files) {
  return files
    .map((f) => {
      const src = readFileSync(join(ROOT, 'src', f), 'utf8');
      return `// ===== src/${f} =====\n` + src.split('// @export')[0].trim();
    })
    .join('\n\n');
}

function code(files, glue) {
  const header =
    '// WYGENEROWANE przez scripts/build_workflows.mjs z plików src/*.js.\n' +
    '// Zmiany wprowadzaj w repozytorium (src/) i przebuduj workflow — nie edytuj tego węzła ręcznie.\n\n';
  return header + (files.length ? include(...files) + '\n\n// ===== logika węzła =====\n' : '') + glue.trim() + '\n';
}

function uuid(seed) {
  const h = createHash('sha1').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const rl = (value, mode = 'id', extra = {}) => ({ __rl: true, value, mode, ...extra });
const MY_DRIVE = rl('My Drive', 'list', { cachedResultName: 'My Drive', cachedResultUrl: 'https://drive.google.com/drive/my-drive' });
const cfg = (field) => `={{ $('Konfiguracja').first().json.${field} }}`;

class Workflow {
  constructor(key, name, settings = {}) {
    this.id = WF_IDS[key];
    this.name = name;
    this.nodes = [];
    this.connections = {};
    this.settings = {
      executionOrder: 'v1',
      timezone: 'Europe/Warsaw',
      saveManualExecutions: true,
      callerPolicy: 'workflowsFromSameOwner',
      ...(key === 'error' ? {} : { errorWorkflow: WF_IDS.error }),
      ...settings,
    };
  }

  add(name, type, typeVersion, position, parameters, extra = {}) {
    this.nodes.push({ parameters, id: uuid(this.id + name), name, type, typeVersion, position, ...extra });
    return name;
  }

  connect(from, to, fromOutput = 0, toInput = 0) {
    const c = (this.connections[from] = this.connections[from] || { main: [] });
    while (c.main.length <= fromOutput) c.main.push([]);
    c.main[fromOutput].push({ node: to, type: 'main', index: toInput });
  }

  chain(...names) {
    for (let i = 0; i < names.length - 1; i++) this.connect(names[i], names[i + 1]);
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      nodes: this.nodes,
      connections: this.connections,
      settings: this.settings,
      active: false,
      pinData: {},
      meta: { templateCredsSetupCompleted: false },
      tags: [],
    };
  }
}

// Fabryki węzłów ------------------------------------------------------------------

function setNode(wf, name, pos, fields, includeOtherFields = false) {
  return wf.add(name, 'n8n-nodes-base.set', 3.4, pos, {
    mode: 'manual',
    assignments: {
      assignments: Object.entries(fields).map(([k, v]) => ({
        id: uuid(wf.id + name + k),
        name: k,
        value: v,
        type: typeof v === 'boolean' ? 'boolean' : 'string',
      })),
    },
    includeOtherFields,
    options: {},
  });
}

function codeNode(wf, name, pos, jsCode, extra = {}) {
  return wf.add(name, 'n8n-nodes-base.code', 2, pos, { mode: 'runOnceForAllItems', language: 'javaScript', jsCode }, extra);
}

function ifNode(wf, name, pos, leftValue, operation = 'true', rightValue = '') {
  const type = ['true', 'false'].includes(operation) ? 'boolean' : operation === 'notEmpty' || operation === 'exists' ? 'string' : 'string';
  const operator = { type, operation };
  if (['true', 'false', 'notEmpty', 'exists', 'empty'].includes(operation)) operator.singleValue = true;
  return wf.add(name, 'n8n-nodes-base.if', 2.2, pos, {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [{ id: uuid(wf.id + name), leftValue, rightValue, operator }],
      combinator: 'and',
    },
    looseTypeValidation: true,
    options: {},
  });
}

function driveMove(wf, name, pos, fileIdExpr, folderIdExpr) {
  return wf.add(
    name,
    'n8n-nodes-base.googleDrive',
    3,
    pos,
    { operation: 'move', fileId: rl(fileIdExpr), driveId: MY_DRIVE, folderId: rl(folderIdExpr) },
    { credentials: CRED.drive }
  );
}

function driveUpload(wf, name, pos, nameExpr, folderIdExpr) {
  return wf.add(
    name,
    'n8n-nodes-base.googleDrive',
    3,
    pos,
    { name: nameExpr, driveId: MY_DRIVE, folderId: rl(folderIdExpr), options: {} },
    { credentials: CRED.drive }
  );
}

function sheetsNode(wf, name, pos, operation, sheetName, params, extra = {}) {
  return wf.add(
    name,
    'n8n-nodes-base.googleSheets',
    4.7,
    pos,
    { operation, documentId: rl(cfg('sheetId')), sheetName: rl(sheetName, 'name'), ...params },
    { credentials: CRED.sheets, ...extra }
  );
}

function emailNode(wf, name, pos, subject, html, extra = {}) {
  return wf.add(
    name,
    'n8n-nodes-base.emailSend',
    2.1,
    pos,
    {
      fromEmail: '={{ $env.NOTIFY_EMAIL_FROM }}',
      toEmail: '={{ $env.NOTIFY_EMAIL_TO }}',
      subject,
      emailFormat: 'html',
      html,
      options: { appendAttribution: false },
    },
    { credentials: CRED.smtp, ...extra }
  );
}

// ---------------------------------------------------------------------------
// 00 — Instalacja: tworzy foldery na Drive i arkusz rejestru, zwraca gotowy fragment .env
// ---------------------------------------------------------------------------
function buildSetup() {
  const wf = new Workflow('setup', '00 Instalacja – foldery Drive i arkusz rejestru');
  const { DOC_COLUMNS, ITEM_COLUMNS } = requireSrc('optima_export.js');

  wf.add('Uruchom instalację', 'n8n-nodes-base.manualTrigger', 1, [0, 300], {});
  wf.add(
    'Utwórz folder główny',
    'n8n-nodes-base.googleDrive',
    3,
    [220, 300],
    {
      resource: 'folder',
      name: 'Obieg dokumentów',
      driveId: MY_DRIVE,
      folderId: rl('root', 'list', { cachedResultName: '/ (Root folder)' }),
      options: {},
    },
    { credentials: CRED.drive }
  );
  codeNode(
    wf,
    'Lista podfolderów',
    [440, 300],
    code(
      [],
      `
const parentId = $input.first().json.id;
const folders = [
  ['00_Wejscie', 'DRIVE_FOLDER_WEJSCIE'],
  ['10_W_trakcie', 'DRIVE_FOLDER_W_TRAKCIE'],
  ['20_Do_weryfikacji', 'DRIVE_FOLDER_WERYFIKACJA'],
  ['30_Archiwum', 'DRIVE_FOLDER_ARCHIWUM'],
  ['40_Eksport_Optima', 'DRIVE_FOLDER_EKSPORT'],
  ['90_Bledy', 'DRIVE_FOLDER_BLEDY'],
];
return folders.map(([name, env]) => ({ json: { name, env, parentId } }));
`
    )
  );
  wf.add(
    'Utwórz podfoldery',
    'n8n-nodes-base.googleDrive',
    3,
    [660, 300],
    { resource: 'folder', name: '={{ $json.name }}', driveId: MY_DRIVE, folderId: rl('={{ $json.parentId }}'), options: {} },
    { credentials: CRED.drive }
  );
  wf.add(
    'Utwórz arkusz rejestru',
    'n8n-nodes-base.httpRequest',
    4.2,
    [880, 300],
    {
      method: 'POST',
      url: 'https://sheets.googleapis.com/v4/spreadsheets',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'googleSheetsOAuth2Api',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: JSON.stringify({
        properties: { title: 'Rejestr dokumentów – obieg', locale: 'pl_PL', timeZone: 'Europe/Warsaw' },
        sheets: [
          { properties: { sheetId: 0, title: 'Dokumenty', gridProperties: { frozenRowCount: 1, columnCount: DOC_COLUMNS.length + 5 } } },
          { properties: { sheetId: 1, title: 'Pozycje', gridProperties: { frozenRowCount: 1, columnCount: ITEM_COLUMNS.length + 5 } } },
        ],
      }),
      options: {},
    },
    { credentials: CRED.sheets, executeOnce: true }
  );
  const statusCol = DOC_COLUMNS.indexOf('status');
  const colorRule = (text, rgb) => ({
    addConditionalFormatRule: {
      rule: {
        ranges: [{ sheetId: 0, startRowIndex: 1, startColumnIndex: statusCol, endColumnIndex: statusCol + 1 }],
        booleanRule: { condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: text }] }, format: { backgroundColor: rgb } },
      },
    },
  });
  wf.add(
    'Nagłówki i formatowanie',
    'n8n-nodes-base.httpRequest',
    4.2,
    [1100, 300],
    {
      method: 'POST',
      url: '=https://sheets.googleapis.com/v4/spreadsheets/{{ $json.spreadsheetId }}:batchUpdate',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'googleSheetsOAuth2Api',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: JSON.stringify({
        requests: [
          {
            updateCells: {
              start: { sheetId: 0, rowIndex: 0, columnIndex: 0 },
              rows: [{ values: DOC_COLUMNS.map((c) => ({ userEnteredValue: { stringValue: c }, userEnteredFormat: { textFormat: { bold: true } } })) }],
              fields: 'userEnteredValue,userEnteredFormat.textFormat.bold',
            },
          },
          {
            updateCells: {
              start: { sheetId: 1, rowIndex: 0, columnIndex: 0 },
              rows: [{ values: ITEM_COLUMNS.map((c) => ({ userEnteredValue: { stringValue: c }, userEnteredFormat: { textFormat: { bold: true } } })) }],
              fields: 'userEnteredValue,userEnteredFormat.textFormat.bold',
            },
          },
          {
            setDataValidation: {
              range: { sheetId: 0, startRowIndex: 1, startColumnIndex: statusCol, endColumnIndex: statusCol + 1 },
              rule: {
                condition: {
                  type: 'ONE_OF_LIST',
                  values: ['OK', 'DO_WERYFIKACJI', 'ZATWIERDZONY', 'ODRZUCONY'].map((v) => ({ userEnteredValue: v })),
                },
                strict: true,
                showCustomUi: true,
              },
            },
          },
          colorRule('OK', { red: 0.85, green: 0.94, blue: 0.83 }),
          colorRule('ZATWIERDZONY', { red: 0.8, green: 0.9, blue: 0.97 }),
          colorRule('DO_WERYFIKACJI', { red: 0.99, green: 0.85, blue: 0.8 }),
          colorRule('ODRZUCONY', { red: 0.85, green: 0.85, blue: 0.85 }),
        ],
      }),
      options: {},
    },
    { credentials: CRED.sheets }
  );
  wf.add(
    'Przenieś arkusz do folderu',
    'n8n-nodes-base.googleDrive',
    3,
    [1320, 300],
    {
      operation: 'move',
      fileId: rl("={{ $('Utwórz arkusz rejestru').first().json.spreadsheetId }}"),
      driveId: MY_DRIVE,
      folderId: rl("={{ $('Utwórz folder główny').first().json.id }}"),
    },
    { credentials: CRED.drive }
  );
  codeNode(
    wf,
    'Fragment .env do skopiowania',
    [1540, 300],
    code(
      [],
      `
const defs = $('Lista podfolderów').all();
const created = $('Utwórz podfoldery').all();
const lines = ['# --- wklej do pliku .env (na serwerze) i zrestartuj n8n ---'];
defs.forEach((d, i) => lines.push(d.json.env + '=' + created[i].json.id));
lines.push('SHEET_REJESTR_ID=' + $('Utwórz arkusz rejestru').first().json.spreadsheetId);
const root = $('Utwórz folder główny').first().json.id;
return [{ json: {
  env: lines.join('\\n'),
  folder: 'https://drive.google.com/drive/folders/' + root,
  arkusz: $('Utwórz arkusz rejestru').first().json.spreadsheetUrl,
} }];
`
    )
  );
  wf.chain('Uruchom instalację', 'Utwórz folder główny', 'Lista podfolderów', 'Utwórz podfoldery', 'Utwórz arkusz rejestru', 'Nagłówki i formatowanie', 'Przenieś arkusz do folderu', 'Fragment .env do skopiowania');
  return wf;
}

// ---------------------------------------------------------------------------
// 01 — Poczta: załączniki z maili trafiają do 00_Wejscie
// ---------------------------------------------------------------------------
function buildEmailIntake() {
  const wf = new Workflow('email', '01 Poczta → folder wejściowy');
  wf.add(
    'Nowe maile z załącznikami',
    'n8n-nodes-base.emailReadImap',
    2.1,
    [0, 300],
    {
      mailbox: '={{ $env.IMAP_MAILBOX || "INBOX" }}',
      postProcessAction: 'read',
      downloadAttachments: true,
      format: 'simple',
      dataPropertyAttachmentsPrefixName: 'attachment_',
      options: { customEmailConfig: '["UNSEEN"]' },
    },
    { credentials: CRED.imap }
  );
  codeNode(
    wf,
    'Wybierz załączniki',
    [240, 300],
    code(
      ['filename.js'],
      `
// Zostawiamy tylko dokumenty (PDF i zdjęcia). Małe obrazki to zwykle logotypy ze stopki maila.
const ALLOWED = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const MIN_IMAGE_BYTES = 30 * 1024;
const out = [];
const items = $input.all();
for (let i = 0; i < items.length; i++) {
  const item = items[i];
  const from = String(item.json.from || '');
  const sender = (from.match(/<([^>]+)>/) || [null, from])[1].split('@')[0];
  const date = new Date(item.json.date || Date.now()).toISOString().slice(0, 10);
  for (const [key, bin] of Object.entries(item.binary || {})) {
    const mime = String(bin.mimeType || '').toLowerCase();
    if (!ALLOWED.includes(mime)) continue;
    if (mime.startsWith('image/')) {
      const buf = await this.helpers.getBinaryDataBuffer(i, key);
      if (buf.length < MIN_IMAGE_BYTES) continue;
    }
    const original = bin.fileName || key;
    out.push({
      json: {
        fileName: sanitizeFilePart(date + '_mail_' + sender + '_' + original, 150),
        from,
        subject: item.json.subject || '',
      },
      binary: { data: bin },
      pairedItem: { item: i },
    });
  }
}
return out;
`
    )
  );
  driveUpload(wf, 'Zapisz w 00_Wejscie', [480, 300], '={{ $json.fileName }}', '={{ $env.DRIVE_FOLDER_WEJSCIE }}');
  wf.chain('Nowe maile z załącznikami', 'Wybierz załączniki', 'Zapisz w 00_Wejscie');
  return wf;
}

// ---------------------------------------------------------------------------
// 02 — Co minutę: pliki z 00_Wejscie -> 10_W_trakcie -> przetwarzanie (sub-workflow 03)
// ---------------------------------------------------------------------------
function buildPoller() {
  const wf = new Workflow('poll', '02 Skrzynka wejściowa (co minutę)', {
    saveDataSuccessExecution: 'none', // puste przebiegi co minutę nie zaśmiecają historii
  });
  wf.add('Co minutę', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 300], {
    rule: { interval: [{ field: 'minutes', minutesInterval: 1 }] },
  });
  setNode(wf, 'Konfiguracja', [220, 300], {
    folderWejscie: '={{ $env.DRIVE_FOLDER_WEJSCIE }}',
    folderWTrakcie: '={{ $env.DRIVE_FOLDER_W_TRAKCIE }}',
    folderBledy: '={{ $env.DRIVE_FOLDER_BLEDY }}',
    batchSize: '={{ $env.POLL_BATCH_SIZE || 10 }}',
  });
  wf.add(
    'Nowe pliki w 00_Wejscie',
    'n8n-nodes-base.googleDrive',
    3,
    [440, 300],
    {
      resource: 'fileFolder',
      searchMethod: 'query',
      queryString:
        "='{{ $json.folderWejscie }}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'",
      limit: "={{ Number($json.batchSize) }}",
      filter: {},
      options: { fields: ['id', 'name', 'mimeType', 'webViewLink'] },
    },
    { credentials: CRED.drive }
  );
  driveMove(wf, 'Przenieś do 10_W_trakcie', [660, 300], '={{ $json.id }}', cfg('folderWTrakcie'));
  // Pętla po jednym pliku: błąd jednego dokumentu nie zatrzymuje pozostałych,
  // a w gałęzi błędu zawsze wiemy, którego pliku dotyczy.
  wf.add('Po jednym pliku', 'n8n-nodes-base.splitInBatches', 3, [880, 300], { batchSize: 1, options: {} });
  wf.add(
    'Przetwórz dokument',
    'n8n-nodes-base.executeWorkflow',
    1.2,
    [1100, 380],
    {
      source: 'database',
      workflowId: rl(WF_IDS.process, 'id', { cachedResultName: '03 Przetwarzanie dokumentu' }),
      mode: 'once',
      workflowInputs: {
        mappingMode: 'defineBelow',
        value: {
          fileId: '={{ $json.id }}',
          fileName: '={{ $json.name }}',
          mimeType: '={{ $json.mimeType }}',
        },
        matchingColumns: [],
        schema: ['fileId', 'fileName', 'mimeType'].map((id) => ({
          id,
          displayName: id,
          required: false,
          defaultMatch: false,
          display: true,
          canBeUsedToMatch: true,
          type: 'string',
          removed: false,
        })),
        attemptToConvertTypes: false,
        convertFieldsToString: true,
      },
      options: { waitForSubWorkflow: true },
    },
    { onError: 'continueRegularOutput', alwaysOutputData: true }
  );
  ifNode(wf, 'Błąd?', [1320, 380], '={{ $json.error }}', 'exists');
  setNode(wf, 'Błąd przetwarzania', [1540, 480], {
    fileId: "={{ $('Po jednym pliku').first().json.id }}",
    fileName: "={{ $('Po jednym pliku').first().json.name }}",
    error: '={{ typeof $json.error === "string" ? $json.error : ($json.error.message || JSON.stringify($json.error)) }}',
  });
  driveMove(wf, 'Przenieś do 90_Bledy', [1760, 480], "={{ $('Błąd przetwarzania').first().json.fileId }}", cfg('folderBledy'));
  emailNode(
    wf,
    'Alert: błąd przetwarzania',
    [1980, 480],
    "=[Obieg dokumentów] Błąd przetwarzania: {{ $('Błąd przetwarzania').first().json.fileName }}",
    `=<p>Nie udało się automatycznie przetworzyć pliku <b>{{ $('Błąd przetwarzania').first().json.fileName }}</b>.</p>
<p>Błąd: <code>{{ $('Błąd przetwarzania').first().json.error }}</code></p>
<p>Plik przeniesiono do folderu <b>90_Bledy</b>:
<a href="https://drive.google.com/file/d/{{ $('Błąd przetwarzania').first().json.fileId }}/view">otwórz plik</a>.
Po wyjaśnieniu problemu przenieś go z powrotem do <b>00_Wejscie</b> albo zaksięguj ręcznie.</p>`
  );
  wf.chain('Co minutę', 'Konfiguracja', 'Nowe pliki w 00_Wejscie', 'Przenieś do 10_W_trakcie', 'Po jednym pliku');
  wf.connect('Po jednym pliku', 'Przetwórz dokument', 1);
  wf.connect('Przetwórz dokument', 'Błąd?');
  wf.connect('Błąd?', 'Błąd przetwarzania', 0);
  wf.connect('Błąd?', 'Po jednym pliku', 1);
  wf.chain('Błąd przetwarzania', 'Przenieś do 90_Bledy', 'Alert: błąd przetwarzania', 'Po jednym pliku');
  return wf;
}

// ---------------------------------------------------------------------------
// 03 — Przetwarzanie jednego dokumentu (wywoływany przez 02)
// ---------------------------------------------------------------------------
function buildProcess() {
  // Bez errorWorkflow: błędy 03 obsługuje wywołujący go 02 (plik -> 90_Bledy + jeden e-mail).
  const wf = new Workflow('process', '03 Przetwarzanie dokumentu');
  delete wf.settings.errorWorkflow;
  wf.add('Wywołanie z 02', 'n8n-nodes-base.executeWorkflowTrigger', 1.1, [0, 300], {
    workflowInputs: {
      values: [
        { name: 'fileId', type: 'string' },
        { name: 'fileName', type: 'string' },
        { name: 'mimeType', type: 'string' },
      ],
    },
  });
  setNode(wf, 'Konfiguracja', [200, 300], {
    fileId: '={{ $json.fileId }}',
    fileName: '={{ $json.fileName }}',
    mimeType: '={{ $json.mimeType }}',
    folderArchiwum: '={{ $env.DRIVE_FOLDER_ARCHIWUM }}',
    folderWeryfikacja: '={{ $env.DRIVE_FOLDER_WERYFIKACJA }}',
    sheetId: '={{ $env.SHEET_REJESTR_ID }}',
    nipFirmy: '={{ $env.NIP_FIRMY || "" }}',
    filenameTemplate: '={{ $env.FILENAME_TEMPLATE || "" }}',
    tolLineGr: '={{ $env.TOL_LINE_GR || 2 }}',
    tolDocGr: '={{ $env.TOL_DOC_GR || 5 }}',
    minPewnosc: '={{ $env.MIN_PEWNOSC || 0.8 }}',
  });
  wf.add(
    'Pobierz plik',
    'n8n-nodes-base.googleDrive',
    3,
    [400, 300],
    { operation: 'download', fileId: rl('={{ $json.fileId }}'), options: { binaryPropertyName: 'data' } },
    { credentials: CRED.drive }
  );
  ifNode(wf, 'Zdjęcie?', [600, 300], "={{ ($binary.data.mimeType || '').startsWith('image/') }}");
  wf.add('Zmniejsz zdjęcie', 'n8n-nodes-base.editImage', 1, [800, 200], {
    operation: 'resize',
    dataPropertyName: 'data',
    width: 2000,
    height: 2000,
    resizeOption: 'onlyIfLarger',
    options: { format: 'jpeg', quality: 85 },
  });
  codeNode(
    wf,
    'Przygotuj zapytanie',
    [1000, 300],
    code(
      ['extraction.js'],
      `
const cfg = $('Konfiguracja').first().json;
const item = $input.first();
const bin = item.binary && item.binary.data;
if (!bin) throw new Error('Brak pliku do odczytu (' + cfg.fileName + ').');
const SUPPORTED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];
let mediaType = String(bin.mimeType || cfg.mimeType || '').toLowerCase();
if (mediaType === 'image/jpg') mediaType = 'image/jpeg';
if (!SUPPORTED.includes(mediaType)) {
  throw new Error('Nieobsługiwany format pliku ' + (mediaType || 'nieznany') + ' (' + cfg.fileName + '). Obsługiwane: PDF, JPG, PNG, WEBP.');
}
const buffer = await this.helpers.getBinaryDataBuffer(0, 'data');
if (buffer.length > 30 * 1024 * 1024) throw new Error('Plik większy niż 30 MB — limit API.');
const request = buildClaudeRequest({ base64: buffer.toString('base64'), mediaType, model: MODEL_PRIMARY });
return [{ json: { request } }];
`
    )
  );
  wf.add(
    'Claude – odczyt dokumentu',
    'n8n-nodes-base.httpRequest',
    4.2,
    [1200, 300],
    {
      method: 'POST',
      url: 'https://api.anthropic.com/v1/messages',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'anthropicApi',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'anthropic-version', value: '2023-06-01' }] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.request) }}',
      options: { timeout: 180000 },
    },
    { credentials: CRED.anthropic, retryOnFail: true, maxTries: 3, waitBetweenTries: 5000 }
  );
  codeNode(
    wf,
    'Odczytaj odpowiedź',
    [1400, 300],
    code(
      ['extraction.js', 'validate.js'],
      `
const parsed = parseClaudeResponse($input.first().json);
let kosztUsd = estimateCostUsd(parsed.model, parsed.usage) || 0;
// Przy ponownym odczycie (model zapasowy) doliczamy koszt pierwszej próby.
if ($runIndex > 0) {
  try { kosztUsd += Number($('Odczytaj odpowiedź').first(0, $runIndex - 1).json.kosztUsd) || 0; } catch (e) {}
}
return [{ json: {
  doc: parsed.data,
  model: parsed.model,
  usage: parsed.usage,
  kosztUsd: Math.round(kosztUsd * 100000) / 100000,
  key: documentKey(parsed.data),
} }];
`
    )
  );
  sheetsNode(
    wf,
    'Sprawdź duplikaty',
    [1600, 300],
    'read',
    'Dokumenty',
    {
      filtersUI: { values: [{ lookupColumn: 'klucz', lookupValue: '={{ $json.key }}' }] },
      options: {},
    },
    { alwaysOutputData: true, onError: 'continueRegularOutput' }
  );
  codeNode(
    wf,
    'Walidacja matematyczna',
    [1800, 300],
    code(
      ['validate.js', 'extraction.js'],
      `
const cfg = $('Konfiguracja').first().json;
const r = $('Odczytaj odpowiedź').first().json;
const existingKeys = $input.all().map((i) => i.json && i.json.klucz).filter(Boolean).map(String);
const validation = validateDocument(r.doc, {
  tolLineGr: Number(cfg.tolLineGr),
  tolDocGr: Number(cfg.tolDocGr),
  minPewnosc: Number(cfg.minPewnosc),
  nipFirmy: cfg.nipFirmy,
  existingKeys,
});
// Jedna ponowna próba mocniejszym modelem, gdy błąd może wynikać ze złego odczytu.
const retry = validation.needsRetry && !String(r.model).startsWith(MODEL_FALLBACK);
return [{ json: Object.assign({}, r, { validation, retry }) }];
`
    )
  );
  ifNode(wf, 'Ponowić modelem Sonnet?', [2000, 300], '={{ $json.retry }}');
  codeNode(
    wf,
    'Zapytanie – Sonnet 5',
    [2000, 80],
    code(
      ['extraction.js'],
      `
const base = $('Przygotuj zapytanie').first().json.request;
const request = Object.assign({}, base, {
  model: MODEL_FALLBACK,
  output_config: Object.assign({}, base.output_config, { effort: 'medium' }),
});
return [{ json: { request } }];
`
    )
  );
  codeNode(
    wf,
    'Nazwa pliku i decyzja',
    [2200, 400],
    code(
      ['filename.js', 'validate.js'],
      `
const cfg = $('Konfiguracja').first().json;
const r = $input.first().json;
const v = r.validation;
const doc = r.doc || {};
const fileName = buildFileName(doc, {
  template: cfg.filenameTemplate || undefined,
  originalName: cfg.fileName,
  mimeType: cfg.mimeType,
  prefix: v.ok ? '' : 'SPRAWDZ',
});
const fileLink = 'https://drive.google.com/file/d/' + cfg.fileId + '/view';
const sheetLink = 'https://docs.google.com/spreadsheets/d/' + cfg.sheetId;
const kwota = doc.suma_brutto != null ? fmtGr(toGr(doc.suma_brutto)) + ' ' + (doc.waluta || 'PLN') : 'brak kwoty';
const kontrahent = (doc.sprzedawca && doc.sprzedawca.nazwa) || 'nieznany kontrahent';
const li = (arr) => arr.map((e) => '<li>' + String(e.message).replace(/</g, '&lt;') + '</li>').join('');
const emailSubject = '[Do weryfikacji] ' + (doc.numer || cfg.fileName) + ' – ' + kontrahent + ' – ' + kwota;
const emailHtml =
  '<p>Dokument <b>' + (doc.numer || cfg.fileName) + '</b> od <b>' + kontrahent + '</b> (' + kwota + ') wymaga ręcznej weryfikacji.</p>' +
  '<p><b>Wykryte rozbieżności:</b></p><ul>' + li(v.errors) + '</ul>' +
  (v.warnings.length ? '<p>Ostrzeżenia:</p><ul>' + li(v.warnings) + '</ul>' : '') +
  '<p>📄 <a href="' + fileLink + '">Otwórz plik</a> (folder 20_Do_weryfikacji, nazwa: ' + fileName + ')<br>' +
  '📊 <a href="' + sheetLink + '">Rejestr dokumentów</a> — popraw dane w arkuszu i ustaw status <b>ZATWIERDZONY</b> ' +
  '(albo <b>ODRZUCONY</b>), a dokument trafi do najbliższego eksportu do Optimy.</p>' +
  '<p style="color:#888">Odczyt: ' + r.model + ', pewność ' + doc.pewnosc + ', koszt ' + r.kosztUsd + ' USD.</p>';
return [{ json: {
  ok: v.ok,
  fileName,
  fileLink,
  archiveMonth: archiveFolderName(doc),
  emailSubject,
  emailHtml,
} }];
`
    )
  );
  ifNode(wf, 'Dokument poprawny?', [2400, 400], '={{ $json.ok }}');
  wf.add(
    'Szukaj folderu miesiąca',
    'n8n-nodes-base.googleDrive',
    3,
    [2600, 300],
    {
      resource: 'fileFolder',
      searchMethod: 'query',
      queryString:
        "='{{ $('Konfiguracja').first().json.folderArchiwum }}' in parents and name = '{{ $json.archiveMonth }}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
      limit: 1,
      filter: {},
      options: {},
    },
    { credentials: CRED.drive, alwaysOutputData: true }
  );
  ifNode(wf, 'Folder istnieje?', [2800, 300], '={{ $json.id }}', 'exists');
  wf.add(
    'Utwórz folder miesiąca',
    'n8n-nodes-base.googleDrive',
    3,
    [3000, 380],
    {
      resource: 'folder',
      name: "={{ $('Nazwa pliku i decyzja').first().json.archiveMonth }}",
      driveId: MY_DRIVE,
      folderId: rl(cfg('folderArchiwum')),
      options: {},
    },
    { credentials: CRED.drive }
  );
  setNode(wf, 'Folder docelowy', [3200, 400], {
    targetFolderId:
      "={{ $('Nazwa pliku i decyzja').first().json.ok ? $json.id : $('Konfiguracja').first().json.folderWeryfikacja }}",
  });
  wf.add(
    'Zmień nazwę pliku',
    'n8n-nodes-base.googleDrive',
    3,
    [3400, 400],
    {
      operation: 'update',
      fileId: rl(cfg('fileId')),
      newUpdatedFileName: "={{ $('Nazwa pliku i decyzja').first().json.fileName }}",
      options: {},
    },
    { credentials: CRED.drive }
  );
  driveMove(wf, 'Przenieś plik', [3600, 400], cfg('fileId'), "={{ $('Folder docelowy').first().json.targetFolderId }}");
  codeNode(
    wf,
    'Wiersz rejestru',
    [3800, 400],
    code(
      ['optima_export.js'],
      `
const cfg = $('Konfiguracja').first().json;
const r = $('Walidacja matematyczna').first().json;
const d = $('Nazwa pliku i decyzja').first().json;
const { dokument } = toRegisterRecords(r.doc, r.validation, {
  model: r.model,
  kosztUsd: r.kosztUsd,
  fileName: d.fileName,
  fileLink: d.fileLink,
  fileId: cfg.fileId,
});
return [{ json: dokument }];
`
    )
  );
  const appendOptions = { cellFormat: 'RAW', useAppend: true, handlingExtraData: 'ignoreIt' };
  sheetsNode(wf, 'Zapisz w rejestrze', [4000, 300], 'append', 'Dokumenty', {
    columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [] },
    options: appendOptions,
  });
  codeNode(
    wf,
    'Pozycje dokumentu',
    [4200, 300],
    code(
      ['optima_export.js'],
      `
const r = $('Walidacja matematyczna').first().json;
const { pozycje } = toRegisterRecords(r.doc, r.validation, {});
return pozycje.map((p) => ({ json: p }));
`
    )
  );
  sheetsNode(wf, 'Zapisz pozycje', [4400, 300], 'append', 'Pozycje', {
    columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [] },
    options: appendOptions,
  });
  ifNode(wf, 'Wymaga weryfikacji?', [4000, 520], "={{ $json.status === 'DO_WERYFIKACJI' }}");
  emailNode(
    wf,
    'Powiadomienie: do weryfikacji',
    [4200, 500],
    "={{ $('Nazwa pliku i decyzja').first().json.emailSubject }}",
    "={{ $('Nazwa pliku i decyzja').first().json.emailHtml }}"
  );

  wf.chain('Wywołanie z 02', 'Konfiguracja', 'Pobierz plik', 'Zdjęcie?');
  wf.connect('Zdjęcie?', 'Zmniejsz zdjęcie', 0);
  wf.connect('Zdjęcie?', 'Przygotuj zapytanie', 1);
  wf.connect('Zmniejsz zdjęcie', 'Przygotuj zapytanie');
  wf.chain('Przygotuj zapytanie', 'Claude – odczyt dokumentu', 'Odczytaj odpowiedź', 'Sprawdź duplikaty', 'Walidacja matematyczna', 'Ponowić modelem Sonnet?');
  wf.connect('Ponowić modelem Sonnet?', 'Zapytanie – Sonnet 5', 0);
  wf.connect('Zapytanie – Sonnet 5', 'Claude – odczyt dokumentu');
  wf.connect('Ponowić modelem Sonnet?', 'Nazwa pliku i decyzja', 1);
  wf.connect('Nazwa pliku i decyzja', 'Dokument poprawny?');
  wf.connect('Dokument poprawny?', 'Szukaj folderu miesiąca', 0);
  wf.connect('Dokument poprawny?', 'Folder docelowy', 1);
  wf.connect('Szukaj folderu miesiąca', 'Folder istnieje?');
  wf.connect('Folder istnieje?', 'Folder docelowy', 0);
  wf.connect('Folder istnieje?', 'Utwórz folder miesiąca', 1);
  wf.connect('Utwórz folder miesiąca', 'Folder docelowy');
  wf.chain('Folder docelowy', 'Zmień nazwę pliku', 'Przenieś plik', 'Wiersz rejestru', 'Zapisz w rejestrze', 'Pozycje dokumentu', 'Zapisz pozycje');
  wf.connect('Wiersz rejestru', 'Wymaga weryfikacji?');
  wf.connect('Wymaga weryfikacji?', 'Powiadomienie: do weryfikacji', 0);
  return wf;
}

// ---------------------------------------------------------------------------
// 04 — Eksport do Optimy (codziennie + ręcznie)
// ---------------------------------------------------------------------------
function buildExport() {
  const wf = new Workflow('export', '04 Eksport do Comarch Optima');
  wf.add('Codziennie 16:00', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 200], {
    rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 16, triggerAtMinute: 0 }] },
  });
  wf.add('Uruchom ręcznie', 'n8n-nodes-base.manualTrigger', 1, [0, 400], {});
  setNode(wf, 'Konfiguracja', [220, 300], {
    sheetId: '={{ $env.SHEET_REJESTR_ID }}',
    folderEksport: '={{ $env.DRIVE_FOLDER_EKSPORT }}',
  });
  const readOptions = {
    options: { outputFormatting: { values: { general: 'UNFORMATTED_VALUE', date: 'FORMATTED_STRING' } } },
  };
  sheetsNode(wf, 'Czytaj Dokumenty', [440, 300], 'read', 'Dokumenty', readOptions, { executeOnce: true, alwaysOutputData: true });
  sheetsNode(wf, 'Czytaj Pozycje', [660, 300], 'read', 'Pozycje', readOptions, { executeOnce: true, alwaysOutputData: true });
  codeNode(
    wf,
    'Buduj pliki eksportu',
    [880, 300],
    code(
      ['optima_export.js'],
      `
const docs = $('Czytaj Dokumenty').all().map((i) => i.json).filter((j) => j && j.klucz);
const items = $('Czytaj Pozycje').all().map((i) => i.json).filter((j) => j && j.klucz);
const records = recordsFromSheets(docs.filter(isExportable), items);
if (records.length === 0) return [];

const now = new Date();
const stamp = now.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '_');
const { xml, count } = buildOptimaXml(records);
const files = [
  { name: 'optima_rejestr_zakupu_' + stamp + '.xml', content: xml, mime: 'application/xml' },
  { name: 'dokumenty_' + stamp + '.csv', content: buildCsvDokumenty(records), mime: 'text/csv' },
  { name: 'pozycje_' + stamp + '.csv', content: buildCsvPozycje(records), mime: 'text/csv' },
];
const keys = records.map((r) => r.klucz);
return files.map((f) => ({
  json: { fileName: f.name, keys, count: records.length, xmlCount: count, exportedAt: now.toISOString() },
  binary: { data: { data: Buffer.from(f.content, 'utf8').toString('base64'), mimeType: f.mime, fileName: f.name } },
}));
`
    )
  );
  driveUpload(wf, 'Zapisz w 40_Eksport_Optima', [1100, 300], '={{ $json.fileName }}', cfg('folderEksport'));
  codeNode(
    wf,
    'Oznacz jako wyeksportowane',
    [1320, 300],
    code(
      [],
      `
const first = $('Buduj pliki eksportu').first().json;
return first.keys.map((klucz) => ({ json: { klucz, eksport: first.exportedAt } }));
`
    )
  );
  sheetsNode(wf, 'Aktualizuj rejestr', [1540, 300], 'update', 'Dokumenty', {
    columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['klucz'], schema: [] },
    options: { cellFormat: 'RAW' },
  });
  emailNode(
    wf,
    'Podsumowanie eksportu',
    [1760, 300],
    "=[Obieg dokumentów] Eksport do Optimy: {{ $('Buduj pliki eksportu').first().json.count }} dok.",
    `=<p>Przygotowano eksport <b>{{ $('Buduj pliki eksportu').first().json.count }}</b> dokumentów
({{ $('Buduj pliki eksportu').first().json.xmlCount }} faktur w pliku XML rejestru zakupów).</p>
<p>Pliki: {{ $('Buduj pliki eksportu').all().map(i => i.json.fileName).join(', ') }}</p>
<p><a href="https://drive.google.com/drive/folders/{{ $('Konfiguracja').first().json.folderEksport }}">Otwórz folder 40_Eksport_Optima</a></p>`,
    { executeOnce: true }
  );
  wf.connect('Codziennie 16:00', 'Konfiguracja');
  wf.connect('Uruchom ręcznie', 'Konfiguracja');
  wf.chain('Konfiguracja', 'Czytaj Dokumenty', 'Czytaj Pozycje', 'Buduj pliki eksportu', 'Zapisz w 40_Eksport_Optima', 'Oznacz jako wyeksportowane', 'Aktualizuj rejestr', 'Podsumowanie eksportu');
  return wf;
}

// ---------------------------------------------------------------------------
// 99 — Obsługa błędów
// ---------------------------------------------------------------------------
function buildErrorHandler() {
  const wf = new Workflow('error', '99 Obsługa błędów');
  wf.add('Błąd w workflow', 'n8n-nodes-base.errorTrigger', 1, [0, 300], {});
  emailNode(
    wf,
    'Alert e-mail',
    [240, 300],
    '=[n8n] Błąd w workflow: {{ $json.workflow.name }}',
    `=<p>Workflow <b>{{ $json.workflow.name }}</b> zakończył się błędem.</p>
<p>Węzeł: <b>{{ $json.execution.lastNodeExecuted }}</b><br>
Błąd: <code>{{ $json.execution.error.message }}</code></p>
<p><a href="{{ $json.execution.url }}">Otwórz wykonanie w n8n</a></p>`
  );
  wf.connect('Błąd w workflow', 'Alert e-mail');
  return wf;
}

// ---------------------------------------------------------------------------

function requireSrc(file) {
  // Pliki src/ są CommonJS — ładujemy je w izolacji przez Function, bez require.
  const src = readFileSync(join(ROOT, 'src', file), 'utf8');
  const module = { exports: {} };
  new Function('module', 'exports', src)(module, module.exports);
  return module.exports;
}

export function buildAll() {
  return {
    '00_instalacja.json': buildSetup(),
    '01_poczta_do_wejscia.json': buildEmailIntake(),
    '02_skrzynka_wejsciowa.json': buildPoller(),
    '03_przetwarzanie_dokumentu.json': buildProcess(),
    '04_eksport_optima.json': buildExport(),
    '99_obsluga_bledow.json': buildErrorHandler(),
  };
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const outDir = join(ROOT, 'workflows');
  mkdirSync(outDir, { recursive: true });
  for (const [file, wf] of Object.entries(buildAll())) {
    writeFileSync(join(outDir, file), JSON.stringify(wf.toJSON(), null, 2) + '\n');
    console.log(`workflows/${file}  (${wf.nodes.length} węzłów)`);
  }
  mkdirSync(join(ROOT, 'credentials'), { recursive: true });
  writeFileSync(join(ROOT, 'credentials', 'credentials.json'), JSON.stringify(CREDENTIAL_SHELLS, null, 2) + '\n');
  console.log('credentials/credentials.json  (puste szablony — sekrety uzupełniasz w UI n8n)');
}
