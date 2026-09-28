// Rejestr dokumentów (Google Sheets) i eksport do Comarch Optima (CSV + XML).
// Wklejany do węzłów Code w n8n przez scripts/build_workflows.mjs.
//
// UWAGA: struktura XML to szkic formatu „praca rozproszona” Optimy (rejestr zakupów VAT).
// Przed produkcją porównaj ją z plikiem wyeksportowanym z Twojej Optimy
// (Narzędzia -> Praca rozproszona -> Eksport) i popraw wyłącznie OPTIMA_XML_MAPPING / buildOptimaXml.

const DOC_COLUMNS = [
  'klucz', 'status', 'typ', 'numer', 'data_wystawienia', 'data_sprzedazy', 'termin_platnosci',
  'forma_platnosci', 'waluta', 'sprzedawca_nazwa', 'sprzedawca_nip', 'sprzedawca_kraj',
  'sprzedawca_ulica', 'sprzedawca_kod', 'sprzedawca_miasto', 'nabywca_nazwa', 'nabywca_nip',
  'dokument_powiazany', 'suma_netto', 'suma_vat', 'suma_brutto', 'do_zaplaty', 'vat_json',
  'bledy', 'ostrzezenia', 'model', 'pewnosc', 'koszt_usd', 'plik_nazwa', 'plik_link', 'plik_id',
  'przetworzono', 'eksport',
];

const ITEM_COLUMNS = [
  'klucz', 'lp', 'nazwa', 'kod', 'ilosc', 'jm', 'cena_netto', 'stawka_vat',
  'wartosc_netto', 'kwota_vat', 'wartosc_brutto',
];

const STATUS = {
  OK: 'OK',
  DO_WERYFIKACJI: 'DO_WERYFIKACJI',
  ZATWIERDZONY: 'ZATWIERDZONY',
  ODRZUCONY: 'ODRZUCONY',
};

const OPTIMA_XML_MAPPING = {
  namespace: 'http://www.comarch.pl/cdn/optima/offline',
  wersja: '2.00',
  bazaZrodlowa: 'N8N-OBIEG-DOKUMENTOW',
  rejestr: 'ZAKUP', // nazwa rejestru zakupów w Optimie
  akronimZ: 'nip', // 'nip' | 'nazwa' — z czego budować akronim kontrahenta
  rodzajZakupu: 'towary', // towary | usługi | inne | środki trwałe
  kolumnaKpr: 'Zakup towarów',
  odliczeniaVat: 'tak',
  typyDoRejestru: ['FAKTURA', 'FAKTURA_KOREKTA'],
};

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// "PL 123-456-32-18" -> "1234563218"; zagraniczny zostaje z prefiksem: "DE123456789"
function cleanNipExport(nip) {
  return String(nip || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/^PL(?=\d{10}$)/, '');
}

function round2(n) {
  return n === null ? null : Math.round(n * 100) / 100;
}

// --- Rejestr (Sheets) ----------------------------------------------------------

function toRegisterRecords(doc, validation, meta) {
  const d = doc || {};
  const m = meta || {};
  const s = d.sprzedawca || {};
  const n = d.nabywca || {};
  const v = validation || { errors: [], warnings: [] };
  const dokument = {
    klucz: v.key || '',
    status: v.ok ? STATUS.OK : STATUS.DO_WERYFIKACJI,
    typ: d.typ_dokumentu || '',
    numer: d.numer || '',
    data_wystawienia: d.data_wystawienia || '',
    data_sprzedazy: d.data_sprzedazy || '',
    termin_platnosci: d.termin_platnosci || '',
    forma_platnosci: d.forma_platnosci || '',
    waluta: d.waluta || 'PLN',
    sprzedawca_nazwa: s.nazwa || '',
    sprzedawca_nip: cleanNipExport(s.nip),
    sprzedawca_kraj: s.kraj || '',
    sprzedawca_ulica: s.ulica || '',
    sprzedawca_kod: s.kod_pocztowy || '',
    sprzedawca_miasto: s.miasto || '',
    nabywca_nazwa: n.nazwa || '',
    nabywca_nip: cleanNipExport(n.nip),
    dokument_powiazany: d.numer_dokumentu_powiazanego || '',
    suma_netto: toNum(d.suma_netto),
    suma_vat: toNum(d.suma_vat),
    suma_brutto: toNum(d.suma_brutto),
    do_zaplaty: toNum(d.do_zaplaty),
    vat_json: JSON.stringify(d.podsumowanie_vat || []),
    bledy: (v.errors || []).map((e) => e.message).join('\n'),
    ostrzezenia: (v.warnings || []).map((w) => w.message).join('\n'),
    model: m.model || '',
    pewnosc: toNum(d.pewnosc),
    koszt_usd: m.kosztUsd === undefined ? null : m.kosztUsd,
    plik_nazwa: m.fileName || '',
    plik_link: m.fileLink || '',
    plik_id: m.fileId || '',
    przetworzono: m.processedAt || new Date().toISOString(),
    eksport: '',
  };
  const pozycje = (d.pozycje || []).map((p, i) => ({
    klucz: dokument.klucz,
    lp: p.lp || i + 1,
    nazwa: p.nazwa || '',
    kod: p.kod || '',
    ilosc: toNum(p.ilosc),
    jm: p.jm || '',
    cena_netto: toNum(p.cena_netto),
    stawka_vat: p.stawka_vat === null || p.stawka_vat === undefined ? '' : String(p.stawka_vat),
    wartosc_netto: toNum(p.wartosc_netto),
    kwota_vat: toNum(p.kwota_vat),
    wartosc_brutto: toNum(p.wartosc_brutto),
  }));
  return { dokument, pozycje };
}

/** Łączy wiersze z arkuszy Dokumenty + Pozycje w listę dokumentów do eksportu. */
function recordsFromSheets(docRows, itemRows) {
  const itemsByKey = {};
  (itemRows || []).forEach((r) => {
    (itemsByKey[r.klucz] = itemsByKey[r.klucz] || []).push(r);
  });
  return (docRows || []).map((r) => Object.assign({}, r, { pozycje: itemsByKey[r.klucz] || [] }));
}

function isExportable(row) {
  return (row.status === STATUS.OK || row.status === STATUS.ZATWIERDZONY) && !row.eksport;
}

/** Wiersze tabeli VAT: z vat_json (odczyt z dokumentu), a gdy pusty — wyliczone z pozycji. */
function vatRows(rec) {
  let rows = [];
  try {
    rows = JSON.parse(rec.vat_json || '[]');
  } catch (e) {
    rows = [];
  }
  rows = (rows || [])
    .map((r) => ({ stawka: String(r.stawka_vat).replace('%', '').trim().toLowerCase(), netto: toNum(r.netto), vat: toNum(r.vat) }))
    .filter((r) => r.netto !== null);
  if (rows.length > 0) return rows;

  const byRate = {};
  (rec.pozycje || []).forEach((p) => {
    const rate = String(p.stawka_vat || '').replace('%', '').trim().toLowerCase();
    const netto = toNum(p.wartosc_netto);
    if (!rate || netto === null) return;
    byRate[rate] = (byRate[rate] || 0) + Math.round(netto * 100);
  });
  const computed = Object.keys(byRate).map((rate) => {
    const pct = Number(rate);
    const vatGr = Number.isFinite(pct) ? Math.round((byRate[rate] * pct) / 100) : 0;
    return { stawka: rate, netto: byRate[rate] / 100, vat: vatGr / 100 };
  });
  if (computed.length > 0) return computed;
  // Ostatecznie: jedna pozycja z sum dokumentu
  return [{ stawka: '23', netto: toNum(rec.suma_netto) || 0, vat: toNum(rec.suma_vat) || 0 }];
}

// --- CSV ------------------------------------------------------------------------

function csvValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v).replace('.', ',');
  const s = String(v);
  return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function toCsv(columns, rows) {
  const lines = [columns.join(';')];
  rows.forEach((r) => lines.push(columns.map((c) => csvValue(r[c])).join(';')));
  // BOM, żeby Excel/Optima poprawnie rozpoznały UTF-8 z polskimi znakami
  return '﻿' + lines.join('\r\n') + '\r\n';
}

const CSV_DOC_COLUMNS = [
  'klucz', 'typ', 'numer', 'data_wystawienia', 'data_sprzedazy', 'termin_platnosci', 'forma_platnosci',
  'waluta', 'sprzedawca_nazwa', 'sprzedawca_nip', 'sprzedawca_ulica', 'sprzedawca_kod', 'sprzedawca_miasto',
  'dokument_powiazany', 'suma_netto', 'suma_vat', 'suma_brutto', 'plik_nazwa', 'plik_link',
];

function buildCsvDokumenty(records) {
  return toCsv(CSV_DOC_COLUMNS, records);
}

function buildCsvPozycje(records) {
  const rows = [];
  records.forEach((rec) => {
    (rec.pozycje || []).forEach((p) => rows.push(Object.assign({ numer: rec.numer, typ: rec.typ }, p)));
  });
  return toCsv(['klucz', 'typ', 'numer'].concat(ITEM_COLUMNS.slice(1)), rows);
}

// --- XML Optima -----------------------------------------------------------------

function xmlEscape(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function tag(name, value, indent) {
  return `${indent}<${name}>${xmlEscape(value)}</${name}>`;
}

function amount(n) {
  return (Math.round((toNum(n) || 0) * 100) / 100).toFixed(2);
}

// Deterministyczny identyfikator w formacie GUID z klucza dokumentu (FNV-1a),
// żeby ponowny eksport tego samego dokumentu nie tworzył duplikatu w Optimie.
function stableGuid(key) {
  const parts = [];
  for (let seed = 0; seed < 4; seed++) {
    let h = 0x811c9dc5 ^ seed;
    const s = String(key);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    parts.push(h.toString(16).padStart(8, '0'));
  }
  const hex = parts.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`.toUpperCase();
}

function vatStatus(stawka) {
  if (stawka === 'zw') return { stawka: '0.00', status: 'zwolniona' };
  if (stawka === 'np' || stawka === 'oo') return { stawka: '0.00', status: 'nie podlega' };
  const n = Number(stawka);
  return { stawka: (Number.isFinite(n) ? n : 0).toFixed(2), status: 'opodatkowana' };
}

function buildOptimaXml(records, mappingOverrides) {
  const map = Object.assign({}, OPTIMA_XML_MAPPING, mappingOverrides || {});
  const docs = records.filter((r) => map.typyDoRejestru.includes(r.typ));
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(`<ROOT xmlns="${map.namespace}">`);
  out.push('  <REJESTRY_ZAKUPU_VAT>');
  out.push(tag('WERSJA', map.wersja, '    '));
  out.push(tag('BAZA_ZRD_ID', map.bazaZrodlowa, '    '));
  docs.forEach((r) => {
    const i = '      ';
    const kraj = (r.sprzedawca_kraj || 'PL').toUpperCase();
    const krajowy = kraj === 'PL' || kraj === 'POLSKA';
    const akronim = map.akronimZ === 'nazwa' ? String(r.sprzedawca_nazwa || '').slice(0, 20) : r.sprzedawca_nip || String(r.sprzedawca_nazwa || '').slice(0, 20);
    out.push('    <REJESTR_ZAKUPU_VAT>');
    out.push(tag('ID_ZRODLA', stableGuid(r.klucz), i));
    out.push(tag('MODUL', 'Rejestr Vat', i));
    out.push(tag('TYP', 'Rejestr zakupu', i));
    out.push(tag('REJESTR', map.rejestr, i));
    out.push(tag('DATA_WYSTAWIENIA', r.data_wystawienia, i));
    out.push(tag('DATA_ZAKUPU', r.data_sprzedazy || r.data_wystawienia, i));
    out.push(tag('DATA_WPLYWU', String(r.przetworzono || '').slice(0, 10) || r.data_wystawienia, i));
    out.push(tag('TERMIN', r.termin_platnosci || r.data_wystawienia, i));
    out.push(tag('NUMER', r.numer, i));
    out.push(tag('KOREKTA', r.typ === 'FAKTURA_KOREKTA' ? 'Tak' : 'Nie', i));
    if (r.typ === 'FAKTURA_KOREKTA') out.push(tag('KOREKTA_NUMER', r.dokument_powiazany, i));
    out.push(tag('WEWNETRZNA', 'Nie', i));
    out.push(tag('FISKALNA', 'Nie', i));
    out.push(tag('DETALICZNA', 'Nie', i));
    out.push(tag('EKSPORT', krajowy ? 'krajowy' : 'wewnątrzunijny', i));
    out.push(tag('PODATNIK_CZYNNY', 'Tak', i));
    out.push(tag('TYP_PODMIOTU', 'kontrahent', i));
    out.push(tag('PODMIOT', akronim, i));
    out.push(tag('NAZWA1', String(r.sprzedawca_nazwa || '').slice(0, 50), i));
    out.push(tag('NAZWA2', String(r.sprzedawca_nazwa || '').slice(50, 100), i));
    out.push(tag('NIP_KRAJ', krajowy ? 'PL' : kraj, i));
    out.push(tag('NIP', r.sprzedawca_nip, i));
    out.push(tag('KRAJ', krajowy ? 'Polska' : kraj, i));
    out.push(tag('ULICA', r.sprzedawca_ulica, i));
    out.push(tag('MIASTO', r.sprzedawca_miasto, i));
    out.push(tag('KOD_POCZTOWY', r.sprzedawca_kod, i));
    out.push(tag('FORMA_PLATNOSCI', r.forma_platnosci || 'przelew', i));
    out.push(tag('WALUTA', r.waluta && r.waluta !== 'PLN' ? r.waluta : '', i));
    out.push(`${i}<POZYCJE>`);
    vatRows(r).forEach((v) => {
      const st = vatStatus(v.stawka);
      const j = i + '    ';
      out.push(`${i}  <POZYCJA>`);
      out.push(tag('STAWKA_VAT', st.stawka, j));
      out.push(tag('STATUS_VAT', st.status, j));
      out.push(tag('NETTO', amount(v.netto), j));
      out.push(tag('VAT', amount(v.vat), j));
      out.push(tag('RODZAJ_ZAKUPU', map.rodzajZakupu, j));
      out.push(tag('ODLICZENIA_VAT', map.odliczeniaVat, j));
      out.push(tag('KOLUMNA_KPR', map.kolumnaKpr, j));
      out.push(`${i}  </POZYCJA>`);
    });
    out.push(`${i}</POZYCJE>`);
    out.push('    </REJESTR_ZAKUPU_VAT>');
  });
  out.push('  </REJESTRY_ZAKUPU_VAT>');
  out.push('</ROOT>');
  return { xml: out.join('\n') + '\n', count: docs.length };
}

// @export
module.exports = {
  DOC_COLUMNS,
  ITEM_COLUMNS,
  STATUS,
  OPTIMA_XML_MAPPING,
  toRegisterRecords,
  recordsFromSheets,
  isExportable,
  vatRows,
  buildCsvDokumenty,
  buildCsvPozycje,
  buildOptimaXml,
  stableGuid,
};
