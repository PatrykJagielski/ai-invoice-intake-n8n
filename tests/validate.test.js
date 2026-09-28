const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDocument, isValidPlNip, normalizeRate, fmtGr, documentKey } = require('../src/validate.js');
const { validInvoice, validWz, TODAY } = require('./fixtures.js');

const opts = { today: TODAY };
const codes = (r) => r.errors.map((e) => e.code);

test('poprawna faktura z trzema stawkami VAT przechodzi walidację', () => {
  const r = validateDocument(validInvoice(), opts);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.equal(r.needsRetry, false);
  assert.equal(r.key, '1234563218|FV/123/09/2026');
});

test('suma pozycji ≠ podsumowanie -> błąd SUMA_NETTO i ponowienie odczytu', () => {
  const doc = validInvoice();
  doc.suma_netto = 359.3; // przestawione cyfry
  doc.suma_brutto = 434.16;
  const r = validateDocument(doc, opts);
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('SUMA_NETTO'));
  assert.ok(r.errors.find((e) => e.code === 'SUMA_NETTO').message.includes('395,30'));
  assert.equal(r.needsRetry, true);
});

test('błędna kwota VAT w tabeli podsumowania', () => {
  const doc = validInvoice();
  doc.podsumowanie_vat[0].vat = 79.97;
  doc.podsumowanie_vat[0].brutto = 384.17;
  const r = validateDocument(doc, opts);
  assert.ok(codes(r).includes('VAT_STAWKA'));
});

test('ilość × cena ≠ wartość pozycji', () => {
  const doc = validInvoice();
  doc.pozycje[0].cena_netto = 26.5;
  const r = validateDocument(doc, opts);
  assert.deepEqual(codes(r), ['POZYCJA_ILOSC_CENA']);
});

test('zaokrąglenia w granicach tolerancji nie są błędem', () => {
  const doc = validInvoice();
  doc.pozycje[1].cena_netto = 12.2999; // 4 × 12,2999 = 49,1996
  doc.suma_netto = 395.31; // 1 grosz różnicy
  doc.suma_brutto = 470.17;
  const r = validateDocument(doc, opts);
  assert.deepEqual(r.errors, []);
});

test('błędny NIP sprzedawcy', () => {
  const doc = validInvoice();
  doc.sprzedawca.nip = '1234563219';
  const r = validateDocument(doc, opts);
  assert.deepEqual(codes(r), ['ZLY_NIP']);
});

test('sprzedawca zagraniczny — tylko ostrzeżenie', () => {
  const doc = validInvoice();
  doc.sprzedawca.nip = 'DE123456789';
  doc.sprzedawca.kraj = 'DE';
  const r = validateDocument(doc, opts);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.code === 'KONTRAHENT_ZAGRANICZNY'));
});

test('stawka w pozycjach, której brakuje w tabeli VAT', () => {
  const doc = validInvoice();
  doc.podsumowanie_vat = doc.podsumowanie_vat.filter((r) => r.stawka_vat !== '8');
  const r = validateDocument(doc, opts);
  assert.ok(codes(r).includes('VAT_BRAK_STAWKI'));
});

test('faktura bez tabeli VAT — VAT sprawdzany z pozycji', () => {
  const doc = validInvoice();
  doc.podsumowanie_vat = [];
  assert.equal(validateDocument(doc, opts).ok, true);
  doc.suma_vat = 70.86;
  doc.suma_brutto = 466.16;
  assert.ok(codes(validateDocument(doc, opts)).includes('VAT_WYLICZONY'));
});

test('faktura liczona od brutto (tylko wartości brutto w pozycjach)', () => {
  const doc = validInvoice();
  doc.metoda_liczenia_vat = 'od_brutto';
  doc.pozycje.forEach((p) => {
    p.cena_netto = null;
    p.wartosc_netto = null;
    p.kwota_vat = null;
  });
  const r = validateDocument(doc, opts);
  assert.deepEqual(r.errors, []);
  doc.suma_brutto = 480.16;
  doc.suma_netto = 405.3;
  assert.ok(codes(validateDocument(doc, opts)).includes('SUMA_BRUTTO_POZYCJI'));
});

test('WZ bez kwot — sprawdzane tylko ilości', () => {
  assert.equal(validateDocument(validWz(), opts).ok, true);
  const wz = validWz();
  wz.pozycje[1].ilosc = null;
  assert.deepEqual(codes(validateDocument(wz, opts)), ['BRAK_ILOSCI']);
});

test('duplikat nie wymusza ponownego odczytu', () => {
  const doc = validInvoice();
  const r = validateDocument(doc, Object.assign({ existingKeys: [documentKey(doc)] }, opts));
  assert.deepEqual(codes(r), ['DUPLIKAT']);
  assert.equal(r.needsRetry, false);
});

test('niska pewność odczytu wymusza ponowienie, ale nie blokuje', () => {
  const doc = validInvoice();
  doc.pewnosc = 0.5;
  const r = validateDocument(doc, opts);
  assert.equal(r.ok, true);
  assert.equal(r.needsRetry, true);
});

test('brak wymaganych pól i nierozpoznany typ', () => {
  const r = validateDocument({ typ_dokumentu: 'INNY', pozycje: [] }, opts);
  assert.ok(codes(r).includes('TYP_NIEROZPOZNANY'));
  assert.ok(codes(r).includes('BRAK_NUMERU'));
});

test('ostrzeżenie o innym nabywcy niż nasza firma', () => {
  const r = validateDocument(validInvoice(), Object.assign({ nipFirmy: '1234563218' }, opts));
  assert.ok(r.warnings.some((w) => w.code === 'INNY_NABYWCA'));
});

test('funkcje pomocnicze', () => {
  assert.equal(isValidPlNip('1234563218'), true);
  assert.equal(isValidPlNip('1234567890'), false);
  assert.equal(normalizeRate('23%'), '23');
  assert.equal(normalizeRate(0.08), '8');
  assert.equal(normalizeRate('ZW'), 'zw');
  assert.equal(fmtGr(123456789), '1 234 567,89');
  assert.equal(fmtGr(-5), '-0,05');
});
