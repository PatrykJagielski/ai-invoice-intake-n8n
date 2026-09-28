const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ex = require('../src/optima_export.js');
const { validateDocument } = require('../src/validate.js');
const { validInvoice, validWz, TODAY } = require('./fixtures.js');

function register(doc) {
  const v = validateDocument(doc, { today: TODAY });
  return ex.toRegisterRecords(doc, v, { model: 'claude-haiku-4-5', fileName: 'x.pdf', processedAt: '2026-09-28T10:00:00Z' });
}

test('rekordy rejestru mają komplet kolumn i status', () => {
  const { dokument, pozycje } = register(validInvoice());
  assert.deepEqual(Object.keys(dokument), ex.DOC_COLUMNS);
  assert.equal(dokument.status, 'OK');
  assert.equal(pozycje.length, 4);
  assert.deepEqual(Object.keys(pozycje[0]), ex.ITEM_COLUMNS);
});

test('eksport: tylko OK/ZATWIERDZONY i jeszcze nieeksportowane', () => {
  assert.equal(ex.isExportable({ status: 'OK', eksport: '' }), true);
  assert.equal(ex.isExportable({ status: 'ZATWIERDZONY', eksport: '' }), true);
  assert.equal(ex.isExportable({ status: 'OK', eksport: '2026-09-01' }), false);
  assert.equal(ex.isExportable({ status: 'DO_WERYFIKACJI', eksport: '' }), false);
});

function records() {
  const a = register(validInvoice());
  const b = register(validWz());
  return ex.recordsFromSheets([a.dokument, b.dokument], a.pozycje.concat(b.pozycje));
}

test('CSV: BOM, średnik, przecinek dziesiętny', () => {
  const csv = ex.buildCsvDokumenty(records());
  assert.ok(csv.startsWith('﻿klucz;typ;numer'));
  assert.ok(csv.includes(';470,16;'));
  const poz = ex.buildCsvPozycje(records());
  assert.equal(poz.trim().split('\r\n').length, 1 + 4 + 2);
});

test('XML: tylko faktury, tabela VAT, poprawna składnia', () => {
  const { xml, count } = ex.buildOptimaXml(records());
  assert.equal(count, 1);
  assert.ok(xml.includes('<NUMER>FV/123/09/2026</NUMER>'));
  assert.ok(xml.includes('<STAWKA_VAT>23.00</STAWKA_VAT>'));
  assert.ok(xml.includes('<NETTO>304.20</NETTO>'));
  assert.ok(xml.includes('Łączność'));
  assert.ok(!xml.includes('WZ/77/2026'));
  const f = path.join(os.tmpdir(), `optima-test-${process.pid}.xml`);
  fs.writeFileSync(f, xml);
  execFileSync('xmllint', ['--noout', f]);
  fs.unlinkSync(f);
});

test('tabela VAT wyliczana z pozycji, gdy vat_json pusty (po ręcznej korekcie)', () => {
  const recs = records();
  recs[0].vat_json = '';
  const rows = ex.vatRows(recs[0]);
  const r23 = rows.find((r) => r.stawka === '23');
  assert.equal(r23.netto, 304.2);
  assert.equal(r23.vat, 69.97);
});

test('stabilny identyfikator dokumentu', () => {
  assert.equal(ex.stableGuid('a|b'), ex.stableGuid('a|b'));
  assert.notEqual(ex.stableGuid('a|b'), ex.stableGuid('a|c'));
  assert.match(ex.stableGuid('x'), /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
});

test('NIP w rejestrze bez kresek i prefiksu PL', () => {
  const doc = validInvoice();
  doc.sprzedawca.nip = 'PL 123-456-32-18';
  doc.nabywca.nip = '987-654-32-10';
  const { dokument } = register(doc);
  assert.equal(dokument.sprzedawca_nip, '1234563218');
  assert.equal(dokument.nabywca_nip, '9876543210');
});
