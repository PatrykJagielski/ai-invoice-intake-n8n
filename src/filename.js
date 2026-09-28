// Budowa nazwy pliku archiwalnego wg szablonu.
// Dostępne pola: {data} {rrrr} {mm} {dd} {typ} {nip} {kontrahent} {numer} {oryginal}
// Domyślny szablon: {data}_{typ}_{nip}_{numer}  ->  2026-09-15_FV_1234563218_FV-123-09-2026.pdf

const DEFAULT_FILENAME_TEMPLATE = '{data}_{typ}_{nip}_{numer}';

const TYPE_CODES = {
  FAKTURA: 'FV',
  FAKTURA_KOREKTA: 'KOR',
  WZ: 'WZ',
  ZAMOWIENIE: 'ZAM',
  PARAGON: 'PAR',
  INNY: 'DOK',
};

const PL_CHARS = {
  ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z',
  Ą: 'A', Ć: 'C', Ę: 'E', Ł: 'L', Ń: 'N', Ó: 'O', Ś: 'S', Ź: 'Z', Ż: 'Z',
};

function sanitizeFilePart(value, maxLen) {
  const s = String(value === null || value === undefined ? '' : value)
    .replace(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g, (c) => PL_CHARS[c])
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return maxLen ? s.slice(0, maxLen).replace(/[-.]+$/, '') : s;
}

// Skraca nazwę firmy: usuwa formę prawną i tnie na granicy słowa.
function shortCompanyName(name, maxLen) {
  const cleaned = String(name || '')
    .replace(/\b(sp\.?\s*z\s*o\.?\s*o\.?|sp[óo][łl]ka z ograniczon[ąa] odpowiedzialno[śs]ci[ąa]|s\.?\s*a\.|sp\.?\s*[jkp]\.|sp[óo][łl]ka (jawna|komandytowa|akcyjna|cywilna)|s\.c\.|gmbh|ltd\.?|inc\.?)(?=\s|$|,)/gi, '')
    .replace(/[\s,.-]+$/, '')
    .trim();
  const parts = sanitizeFilePart(cleaned).split('-');
  let out = '';
  for (const part of parts) {
    const next = out ? out + '-' + part : part;
    if (next.length > maxLen) break;
    out = next;
  }
  return out || sanitizeFilePart(cleaned, maxLen);
}

// "PL 123-456-32-18" -> "1234563218"; zagraniczny zostaje z prefiksem: "DE123456789"
function cleanNip(nip) {
  return String(nip || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/^PL(?=\d{10}$)/, '');
}

function fileExtension(originalName, mimeType) {
  const m = String(originalName || '').match(/\.([A-Za-z0-9]{2,5})$/);
  if (m) return '.' + m[1].toLowerCase();
  const byMime = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
  return byMime[mimeType] || '.pdf';
}

function buildFileName(doc, options) {
  const opt = options || {};
  const template = opt.template || DEFAULT_FILENAME_TEMPLATE;
  const d = doc || {};
  const date = /^\d{4}-\d{2}-\d{2}$/.test(d.data_wystawienia || '') ? d.data_wystawienia : 'brak-daty';
  const [rrrr, mm, dd] = date === 'brak-daty' ? ['0000', '00', '00'] : date.split('-');
  const nip = cleanNip(d.sprzedawca && d.sprzedawca.nip) || 'brak-NIP';
  const original = String(opt.originalName || '').replace(/\.[A-Za-z0-9]{2,5}$/, '');

  const values = {
    data: date,
    rrrr,
    mm,
    dd,
    typ: TYPE_CODES[d.typ_dokumentu] || 'DOK',
    nip,
    kontrahent: shortCompanyName((d.sprzedawca && d.sprzedawca.nazwa) || 'brak-kontrahenta', 30),
    numer: sanitizeFilePart(d.numer || 'brak-numeru', 40),
    oryginal: sanitizeFilePart(original, 40),
  };

  let base = template.replace(/\{(\w+)\}/g, (_, k) => (k in values ? values[k] : ''));
  base = sanitizeFilePart(base, 150);
  if (opt.prefix) base = sanitizeFilePart(opt.prefix) + '_' + base;
  return base + fileExtension(opt.originalName, opt.mimeType);
}

function archiveFolderName(doc) {
  const date = doc && /^\d{4}-\d{2}/.test(doc.data_wystawienia || '') ? doc.data_wystawienia.slice(0, 7) : 'bez-daty';
  return date;
}

// @export
module.exports = { cleanNip, DEFAULT_FILENAME_TEMPLATE, TYPE_CODES, buildFileName, archiveFolderName, sanitizeFilePart, shortCompanyName };
