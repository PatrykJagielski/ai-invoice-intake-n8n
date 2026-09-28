#!/usr/bin/env node
// Buduje wariant testowy workflowów 02 + 03, w którym węzły zewnętrzne (Google Drive/Sheets,
// Claude, e-mail, Edit Image) są zastąpione atrapami (węzły Code), a cała reszta — IF-y, Set,
// wyrażenia, pętla ponowienia, Execute Workflow i wyjście błędów — działa w prawdziwym n8n.
//
//   node tests/e2e/build_mock_variant.mjs <katalog_wyjściowy>
//   docker exec n8n n8n import:workflow --separate --input=<katalog>
//   docker exec n8n n8n execute --id=TestDok02Poll000

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildAll, WF_IDS } from '../../scripts/build_workflows.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] || join(HERE, 'out');
mkdirSync(outDir, { recursive: true });

const TEST_IDS = { poll: 'TestDok02Poll000', process: 'TestDok03Proc000' };

// Dokumenty zwracane przez „Claude” — z fixtures testów jednostkowych.
const fixtures = await import(pathToFileURL(join(HERE, '..', 'fixtures.js')).href);
const good = fixtures.default.validInvoice();
const bad = fixtures.default.validInvoice();
bad.numer = 'FV/124/09/2026';
bad.suma_netto = 359.3;

const TEST_ENV = { TOL_LINE_GR: '2', TOL_DOC_GR: '5', MIN_PEWNOSC: '0.8', NIP_FIRMY: '9876543210', FILENAME_TEMPLATE: '', POLL_BATCH_SIZE: '10' };

const MOCKS = {
  // --- 02 ---
  'Co minutę': null, // zamieniany na Manual Trigger
  'Nowe pliki w 00_Wejscie': `return [
    { json: { id: 'F1', name: '01_FV_poprawna.pdf', mimeType: 'application/pdf' } },
    { json: { id: 'F2', name: '02_FV_bledna_suma.pdf', mimeType: 'application/pdf' } },
    { json: { id: 'F3', name: 'notatka.docx', mimeType: 'application/msword' } },
  ];`,
  'Przenieś do 10_W_trakcie': `return $input.all().map(i => ({ json: { id: i.json.id, name: i.json.name, mimeType: i.json.mimeType } }));`,
  'Przenieś do 90_Bledy': `return [{ json: { id: $('Błąd przetwarzania').first().json.fileId, movedTo: $('Konfiguracja').first().json.folderBledy } }];`,
  'Alert: błąd przetwarzania': `return [{ json: { alert: true, file: $('Błąd przetwarzania').first().json.fileName, error: $('Błąd przetwarzania').first().json.error } }];`,
  // --- 03 ---
  'Pobierz plik': `const j = $input.first().json;
    return [{ json: j, binary: { data: { data: Buffer.from('%PDF-1.4 mock ' + j.fileId).toString('base64'), mimeType: j.mimeType, fileName: j.fileName } } }];`,
  'Zmniejsz zdjęcie': `return $input.all();`,
  'Claude – odczyt dokumentu': `const req = $input.first().json.request;
    const fileId = $('Konfiguracja').first().json.fileId;
    const docs = ${JSON.stringify({ F1: good, F2: bad })};
    const doc = docs[fileId];
    return [{ json: { model: req.model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(doc) }], usage: { input_tokens: 3000, output_tokens: 900 } } }];`,
  'Sprawdź duplikaty': `return [];`,
  'Szukaj folderu miesiąca': `return [];`,
  'Utwórz folder miesiąca': `return [{ json: { id: 'FOLDER-' + $('Nazwa pliku i decyzja').first().json.archiveMonth } }];`,
  'Zmień nazwę pliku': `return [{ json: { id: $('Konfiguracja').first().json.fileId, name: $('Nazwa pliku i decyzja').first().json.fileName } }];`,
  'Przenieś plik': `return [{ json: { id: $('Konfiguracja').first().json.fileId, folder: $('Folder docelowy').first().json.targetFolderId } }];`,
  'Zapisz w rejestrze': `return $input.all();`,
  'Zapisz pozycje': `return $input.all();`,
  'Powiadomienie: do weryfikacji': `return [{ json: { mail: $('Nazwa pliku i decyzja').first().json.emailSubject } }];`,
};

function toMock(node, js) {
  return {
    ...node,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: js },
    credentials: undefined,
    retryOnFail: undefined,
  };
}

const all = buildAll();
const variants = {
  poll: all['02_skrzynka_wejsciowa.json'].toJSON(),
  process: all['03_przetwarzanie_dokumentu.json'].toJSON(),
};

for (const [key, wf] of Object.entries(variants)) {
  wf.id = TEST_IDS[key];
  wf.name = 'TEST ' + wf.name;
  delete wf.settings.errorWorkflow;
  wf.settings.saveDataSuccessExecution = 'all';
  wf.nodes = wf.nodes.map((n) => {
    if (n.name === 'Co minutę') return { ...n, type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} };
    if (n.name === 'Przetwórz dokument') {
      return { ...n, parameters: { ...n.parameters, workflowId: { __rl: true, value: TEST_IDS.process, mode: 'id' } } };
    }
    return MOCKS[n.name] ? toMock(n, MOCKS[n.name]) : n;
  });
  // Konfiguracja bez .env: stałe wartości testowe
  wf.nodes.forEach((n) => {
    if (n.name !== 'Konfiguracja') return;
    n.parameters.assignments.assignments.forEach((a) => {
      if (typeof a.value !== 'string' || !a.value.includes('$env')) return;
      const m = a.value.match(/\$env\.(\w+)/);
      a.value = m && m[1] in TEST_ENV ? TEST_ENV[m[1]] : a.value.replace(/\$env\.(\w+)/g, "'TEST_$1'");
    });
  });
  writeFileSync(join(outDir, `${key}.json`), JSON.stringify(wf, null, 2));
}
console.log(`Wariant testowy zapisany w ${outDir} (ID: ${Object.values(TEST_IDS).join(', ')}); oryginał 03: ${WF_IDS.process}`);

// Warianty 03 uruchamiane bezpośrednio (Manual Trigger zamiast wywołania z 02) — do podglądu każdego kroku.
for (const [fileId, fileName] of [['F1', '01_FV_poprawna.pdf'], ['F2', '02_FV_bledna_suma.pdf']]) {
  const wf = JSON.parse(JSON.stringify(variants.process));
  wf.id = `TestDok03Man${fileId}00`;
  wf.name = `TEST 03 ręcznie ${fileId}`;
  wf.nodes = wf.nodes.map((n) => (n.name === 'Wywołanie z 02' ? { ...n, type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} } : n));
  const k = wf.nodes.find((n) => n.name === 'Konfiguracja');
  const fixed = { fileId, fileName, mimeType: 'application/pdf' };
  k.parameters.assignments.assignments.forEach((a) => { if (a.name in fixed) a.value = fixed[a.name]; });
  writeFileSync(join(outDir, `process_manual_${fileId}.json`), JSON.stringify(wf, null, 2));
}
