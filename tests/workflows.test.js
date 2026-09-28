// Testy wygenerowanych workflowów: struktura połączeń + wykonanie kodu węzłów Code
// na atrapie środowiska n8n ($input, $('Węzeł'), this.helpers).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { validInvoice, TODAY } = require('./fixtures.js');

let workflows;
test.before(async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'build_workflows.mjs')).href);
  workflows = Object.fromEntries(Object.entries(mod.buildAll()).map(([f, wf]) => [f, wf.toJSON()]));
});

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function items(list) {
  return list.map((json) => (json && json.json ? json : { json }));
}

function runCode(wf, nodeName, { input = [], nodes = {}, runIndex = 0, buffers = {} } = {}) {
  const node = wf.nodes.find((n) => n.name === nodeName);
  assert.ok(node, `brak węzła ${nodeName}`);
  const accessor = (name) => {
    const data = nodes[name];
    if (!data) throw new Error(`Test nie dostarczył danych węzła ${name}`);
    const list = items(data);
    return { first: () => list[0], last: () => list[list.length - 1], all: () => list, item: list[0] };
  };
  const inputItems = items(input);
  const $input = { first: () => inputItems[0], last: () => inputItems[inputItems.length - 1], all: () => inputItems };
  const ctx = { helpers: { getBinaryDataBuffer: async (i, key) => buffers[`${i}:${key}`] } };
  const fn = new AsyncFunction('$input', '$', '$runIndex', node.parameters.jsCode);
  return fn.call(ctx, $input, accessor, runIndex);
}

test('każde połączenie wskazuje istniejący węzeł, a każdy węzeł poza triggerem ma wejście', () => {
  for (const [file, wf] of Object.entries(workflows)) {
    const names = new Set(wf.nodes.map((n) => n.name));
    const targets = new Set();
    for (const [from, c] of Object.entries(wf.connections)) {
      assert.ok(names.has(from), `${file}: nieznane źródło ${from}`);
      c.main.flat().forEach((t) => {
        assert.ok(names.has(t.node), `${file}: nieznany cel ${t.node}`);
        targets.add(t.node);
      });
    }
    wf.nodes
      .filter((n) => !/Trigger|trigger|emailReadImap/.test(n.type))
      .forEach((n) => assert.ok(targets.has(n.name), `${file}: węzeł „${n.name}” nie ma wejścia`));
  }
});

test('kod wszystkich węzłów Code się kompiluje', () => {
  for (const wf of Object.values(workflows)) {
    wf.nodes.filter((n) => n.type === 'n8n-nodes-base.code').forEach((n) => {
      assert.doesNotThrow(() => new AsyncFunction('$input', '$', '$runIndex', n.parameters.jsCode), `${wf.name} / ${n.name}`);
    });
  }
});

test('odwołania $("Węzeł") w wyrażeniach wskazują istniejące węzły', () => {
  for (const wf of Object.values(workflows)) {
    const names = new Set(wf.nodes.map((n) => n.name));
    const text = JSON.stringify(wf.nodes);
    for (const m of text.matchAll(/\$\(\\?['"]([^'"\\]+)\\?['"]\)/g)) {
      assert.ok(names.has(m[1]), `${wf.name}: odwołanie do nieistniejącego węzła „${m[1]}”`);
    }
  }
});

function claudeResponse(doc, model = 'claude-haiku-4-5') {
  return { model, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(doc) }], usage: { input_tokens: 3000, output_tokens: 900 } };
}

const CFG = {
  fileId: 'FILE123', fileName: 'skan_0001.pdf', mimeType: 'application/pdf', sheetId: 'SHEET1',
  folderArchiwum: 'A', folderWeryfikacja: 'W', nipFirmy: '9876543210', filenameTemplate: '',
  tolLineGr: '2', tolDocGr: '5', minPewnosc: '0.8',
};

async function runProcess(doc, { existing = [], model } = {}) {
  const wf = workflows['03_przetwarzanie_dokumentu.json'];
  const pdf = Buffer.from('%PDF-1.4 test');
  const prep = await runCode(wf, 'Przygotuj zapytanie', {
    input: [{ json: {}, binary: { data: { mimeType: 'application/pdf', fileName: 'skan_0001.pdf' } } }],
    nodes: { Konfiguracja: [CFG] },
    buffers: { '0:data': pdf },
  });
  const req = prep[0].json.request;
  assert.equal(req.model, 'claude-haiku-4-5');
  assert.equal(req.messages[0].content[0].source.data, pdf.toString('base64'));

  const odczyt = await runCode(wf, 'Odczytaj odpowiedź', { input: [claudeResponse(doc, model)] });
  const walid = await runCode(wf, 'Walidacja matematyczna', {
    input: existing.length ? existing.map((k) => ({ klucz: k })) : [{}],
    nodes: { Konfiguracja: [CFG], 'Odczytaj odpowiedź': odczyt },
  });
  const decyzja = await runCode(wf, 'Nazwa pliku i decyzja', { input: walid, nodes: { Konfiguracja: [CFG] } });
  const wiersz = await runCode(wf, 'Wiersz rejestru', {
    nodes: { Konfiguracja: [CFG], 'Walidacja matematyczna': walid, 'Nazwa pliku i decyzja': decyzja },
  });
  const pozycje = await runCode(wf, 'Pozycje dokumentu', { nodes: { 'Walidacja matematyczna': walid } });
  return { prep, odczyt: odczyt[0].json, walid: walid[0].json, decyzja: decyzja[0].json, wiersz: wiersz[0].json, pozycje };
}

test('03: poprawna faktura -> archiwum, wiersz OK, bez ponawiania', async () => {
  const r = await runProcess(validInvoice());
  assert.equal(r.walid.retry, false);
  assert.equal(r.decyzja.ok, true);
  assert.equal(r.decyzja.fileName, '2026-09-15_FV_1234563218_FV-123-09-2026.pdf');
  assert.equal(r.decyzja.archiveMonth, '2026-09');
  assert.equal(r.wiersz.status, 'OK');
  assert.equal(r.wiersz.plik_link, 'https://drive.google.com/file/d/FILE123/view');
  assert.equal(r.pozycje.length, 4);
  assert.ok(r.odczyt.kosztUsd > 0);
});

test('03: błędna suma -> ponowienie Sonnetem, potem weryfikacja z mailem', async () => {
  const doc = validInvoice();
  doc.suma_netto = 359.3;
  const first = await runProcess(doc);
  assert.equal(first.walid.retry, true);

  const wf = workflows['03_przetwarzanie_dokumentu.json'];
  const sonnetReq = await runCode(wf, 'Zapytanie – Sonnet 5', { nodes: { 'Przygotuj zapytanie': first.prep } });
  assert.equal(sonnetReq[0].json.request.model, 'claude-sonnet-5');
  assert.equal(sonnetReq[0].json.request.output_config.effort, 'medium');

  const second = await runProcess(doc, { model: 'claude-sonnet-5' });
  assert.equal(second.walid.retry, false);
  assert.equal(second.decyzja.ok, false);
  assert.match(second.decyzja.fileName, /^SPRAWDZ_2026-09-15_FV_/);
  assert.match(second.decyzja.emailSubject, /^\[Do weryfikacji\] FV\/123\/09\/2026 – Hurtownia/);
  assert.match(second.decyzja.emailHtml, /Suma netto pozycji 395,30/);
  assert.equal(second.wiersz.status, 'DO_WERYFIKACJI');
});

test('03: duplikat trafia do weryfikacji bez ponawiania', async () => {
  const r = await runProcess(validInvoice(), { existing: ['1234563218|FV/123/09/2026'] });
  assert.equal(r.walid.retry, false);
  assert.equal(r.decyzja.ok, false);
  assert.match(r.wiersz.bledy, /jest już w rejestrze/);
});

test('03: nieobsługiwany format pliku kończy się czytelnym błędem', async () => {
  const wf = workflows['03_przetwarzanie_dokumentu.json'];
  await assert.rejects(
    runCode(wf, 'Przygotuj zapytanie', {
      input: [{ json: {}, binary: { data: { mimeType: 'application/msword' } } }],
      nodes: { Konfiguracja: [CFG] },
    }),
    /Nieobsługiwany format/
  );
});

test('04: eksport buduje 3 pliki tylko z dokumentów OK/ZATWIERDZONY', async () => {
  const wf3 = workflows['03_przetwarzanie_dokumentu.json'];
  const ok = await runProcess(validInvoice());
  const bad = validInvoice();
  bad.numer = 'FV/999';
  bad.suma_netto = 1;
  const weryf = await runProcess(bad, { model: 'claude-sonnet-5' });
  assert.ok(wf3);

  const wf = workflows['04_eksport_optima.json'];
  const docs = [ok.wiersz, weryf.wiersz, Object.assign({}, weryf.wiersz, { klucz: 'X|1', status: 'OK', eksport: '2026-09-01T10:00:00Z' })];
  const out = await runCode(wf, 'Buduj pliki eksportu', {
    nodes: { 'Czytaj Dokumenty': docs, 'Czytaj Pozycje': ok.pozycje.map((p) => p.json) },
  });
  assert.equal(out.length, 3);
  assert.deepEqual(out[0].json.keys, ['1234563218|FV/123/09/2026']);
  const xml = Buffer.from(out[0].binary.data.data, 'base64').toString('utf8');
  assert.match(xml, /<NUMER>FV\/123\/09\/2026<\/NUMER>/);
  assert.match(out[1].binary.data.fileName, /^dokumenty_\d{8}_\d{4}\.csv$/);

  const mark = await runCode(wf, 'Oznacz jako wyeksportowane', { nodes: { 'Buduj pliki eksportu': out } });
  assert.deepEqual(mark.map((m) => m.json.klucz), ['1234563218|FV/123/09/2026']);

  const empty = await runCode(wf, 'Buduj pliki eksportu', { nodes: { 'Czytaj Dokumenty': [{}], 'Czytaj Pozycje': [{}] } });
  assert.deepEqual(empty, []);
});

test('01: z maila zostają tylko PDF-y i duże zdjęcia', async () => {
  const wf = workflows['01_poczta_do_wejscia.json'];
  const out = await runCode(wf, 'Wybierz załączniki', {
    input: [
      {
        json: { from: 'Jan Kowalski <jan.kowalski@firma.pl>', date: '2026-09-20T08:00:00Z', subject: 'Faktura' },
        binary: {
          attachment_0: { mimeType: 'application/pdf', fileName: 'FV 12/2026.pdf' },
          attachment_1: { mimeType: 'image/png', fileName: 'logo.png' },
          attachment_2: { mimeType: 'image/jpeg', fileName: 'zdjecie WZ.jpg' },
          attachment_3: { mimeType: 'text/plain', fileName: 'notatka.txt' },
        },
      },
    ],
    buffers: { '0:attachment_1': Buffer.alloc(2000), '0:attachment_2': Buffer.alloc(200000) },
  });
  assert.deepEqual(out.map((o) => o.json.fileName), ['2026-09-20_mail_jan.kowalski_FV-12-2026.pdf', '2026-09-20_mail_jan.kowalski_zdjecie-WZ.jpg']);
});

test('fixture TODAY jest spójna z datami dokumentów', () => {
  assert.ok(TODAY >= validInvoice().data_wystawienia);
});

test('00: arkusz rejestru ma dość kolumn na nagłówki (domyślnie Google tworzy tylko 26)', () => {
  const { DOC_COLUMNS, ITEM_COLUMNS } = require('../src/optima_export.js');
  const wf = workflows['00_instalacja.json'];
  const body = JSON.parse(wf.nodes.find((n) => n.name === 'Utwórz arkusz rejestru').parameters.jsonBody);
  const [dok, poz] = body.sheets.map((s) => s.properties.gridProperties.columnCount);
  assert.ok(dok >= DOC_COLUMNS.length, `Dokumenty: ${dok} < ${DOC_COLUMNS.length}`);
  assert.ok(poz >= ITEM_COLUMNS.length);
});
