const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFileName, archiveFolderName } = require('../src/filename.js');
const { validInvoice, validWz } = require('./fixtures.js');

test('domyślny schemat nazwy faktury', () => {
  const name = buildFileName(validInvoice(), { originalName: 'skan_0001.PDF' });
  assert.equal(name, '2026-09-15_FV_1234563218_FV-123-09-2026.pdf');
});

test('własny szablon z nazwą kontrahenta i polskimi znakami', () => {
  const name = buildFileName(validInvoice(), { template: '{rrrr}{mm}{dd} {kontrahent} {numer}', originalName: 'a.jpg' });
  assert.equal(name, '20260915-Hurtownia-Budowlana-Lacznosc-FV-123-09-2026.jpg');
});

test('WZ i brakujące dane', () => {
  assert.equal(buildFileName(validWz(), { mimeType: 'image/png' }), '2026-09-16_WZ_1234563218_WZ-77-2026.png');
  assert.equal(buildFileName({}, { prefix: 'SPRAWDZ', originalName: 'x.pdf' }), 'SPRAWDZ_brak-daty_DOK_brak-NIP_brak-numeru.pdf');
});

test('folder archiwum wg miesiąca', () => {
  assert.equal(archiveFolderName(validInvoice()), '2026-09');
  assert.equal(archiveFolderName({}), 'bez-daty');
});

test('skracanie nazwy firmy', () => {
  const { shortCompanyName } = require('../src/filename.js');
  assert.equal(shortCompanyName('PHU Kowalski Spółka Jawna', 30), 'PHU-Kowalski');
  assert.equal(shortCompanyName('Orlen S.A.', 30), 'Orlen');
  assert.equal(shortCompanyName('Bardzo Długa Nazwa Przedsiębiorstwa Handlowego', 20), 'Bardzo-Dluga-Nazwa');
});

test('NIP w nazwie pliku niezależnie od zapisu na dokumencie', () => {
  const doc = validInvoice();
  for (const nip of ['123-456-32-18', 'PL 123 456 32 18', 'PL1234563218']) {
    doc.sprzedawca.nip = nip;
    assert.equal(buildFileName(doc, { originalName: 'a.pdf' }), '2026-09-15_FV_1234563218_FV-123-09-2026.pdf');
  }
  doc.sprzedawca.nip = 'DE 123456789';
  assert.match(buildFileName(doc, { originalName: 'a.pdf' }), /_FV_DE123456789_/);
});
