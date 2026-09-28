// Ekstrakcja danych z dokumentu przez Claude (Messages API).
// Ten plik jest wklejany do węzłów Code w n8n przez scripts/build_workflows.mjs,
// dlatego nie używa require/import — tylko czyste funkcje.

const EXTRACTION_SYSTEM_PROMPT = `Jesteś asystentem działu księgowości polskiej firmy. Odczytujesz dokumenty kosztowe (faktury zakupowe, korekty, dokumenty WZ, zamówienia, paragony) ze skanów, zdjęć i plików PDF.

Zasady:
1. PRZEPISUJ wartości dokładnie tak, jak są wydrukowane na dokumencie. Niczego nie przeliczaj, nie poprawiaj i nie uzupełniaj sum na podstawie pozycji — poprawność matematyczną sprawdza osobny, deterministyczny etap. Jeśli suma na dokumencie jest błędna, przepisz ją taką, jaka jest.
2. Jeżeli pola nie ma na dokumencie albo jest nieczytelne: dla pól tekstowych zwróć pusty tekst "", dla liczb null. Nie zgaduj. Nieczytelne fragmenty opisz w polu "uwagi".
3. Kwoty zwracaj jako liczby z kropką dziesiętną (1 234,56 zł -> 1234.56). Ilości również jako liczby.
4. Daty w formacie RRRR-MM-DD.
5. NIP przepisz DOKŁADNIE tak, jak jest wydrukowany — znak po znaku, razem z kreskami, spacjami i ewentualnym prefiksem kraju (np. "123-456-32-18", "PL 1234563218", "DE123456789"). Niczego nie usuwaj ani nie scalaj — normalizację robi system. Kraj kontrahenta podaj w polu "kraj" jako kod ISO (PL, DE, ...).
6. Stawka VAT jako tekst: "23", "8", "5", "0", "zw" (zwolniona), "np" (nie podlega), "oo" (odwrotne obciążenie). Stawki zagraniczne podaj liczbą, np. "19".
7. "cena_netto" to cena jednostkowa netto PO rabacie. Jeśli dokument podaje tylko ceny brutto, wpisz cena_netto = null i uzupełnij wartości brutto; ustaw "metoda_liczenia_vat" = "od_brutto".
8. "podsumowanie_vat" to tabela podsumowania według stawek VAT wydrukowana na dokumencie (jeśli jej nie ma — pusta lista).
9. "sprzedawca" to wystawca faktury (dostawca). Na WZ — wydający towar. Na zamówieniu — dostawca, do którego kierowane jest zamówienie.
10. "typ_dokumentu": FAKTURA, FAKTURA_KOREKTA, WZ (wydanie zewnętrzne / dowód dostawy), ZAMOWIENIE, PARAGON albo INNY.
11. "pewnosc" (0–1): Twoja ocena, na ile odczyt całego dokumentu jest wiarygodny (jakość skanu, czytelność liczb).
12. Dokument wielostronicowy traktuj jako jeden dokument; pozycje ze wszystkich stron w jednej liście.`;

const EXTRACTION_USER_PROMPT = 'Odczytaj dane z załączonego dokumentu zgodnie ze schematem.';

function nullable(schema) {
  return { anyOf: [schema, { type: 'null' }] };
}

function strictObject(properties) {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

// API structured outputs pozwala na max 16 pól z typem „union” (np. liczba lub null).
// Dlatego pola tekstowe są zawsze stringami ("" = brak — zamieniane na null w parseClaudeResponse),
// a null dopuszczamy tylko dla kwot i ilości.
const NSTR = { type: 'string' };
const NNUM = nullable({ type: 'number' });
const MAX_UNION_FIELDS = 16;

const PODMIOT_SCHEMA = strictObject({
  nazwa: NSTR,
  nip: NSTR,
  kraj: NSTR,
  ulica: NSTR,
  kod_pocztowy: NSTR,
  miasto: NSTR,
});

const EXTRACTION_SCHEMA = strictObject({
  typ_dokumentu: {
    type: 'string',
    enum: ['FAKTURA', 'FAKTURA_KOREKTA', 'WZ', 'ZAMOWIENIE', 'PARAGON', 'INNY'],
  },
  numer: NSTR,
  data_wystawienia: NSTR,
  data_sprzedazy: NSTR,
  termin_platnosci: NSTR,
  forma_platnosci: NSTR,
  waluta: NSTR,
  numer_dokumentu_powiazanego: NSTR,
  sprzedawca: PODMIOT_SCHEMA,
  nabywca: PODMIOT_SCHEMA,
  metoda_liczenia_vat: { type: 'string', enum: ['od_netto', 'od_brutto', 'nieznana'] },
  pozycje: {
    type: 'array',
    items: strictObject({
      lp: { type: 'number' },
      nazwa: { type: 'string' },
      kod: NSTR,
      ilosc: NNUM,
      jm: NSTR,
      cena_netto: NNUM,
      stawka_vat: NSTR,
      wartosc_netto: NNUM,
      kwota_vat: NNUM,
      wartosc_brutto: NNUM,
    }),
  },
  podsumowanie_vat: {
    type: 'array',
    items: strictObject({
      stawka_vat: { type: 'string' },
      netto: NNUM,
      vat: NNUM,
      brutto: NNUM,
    }),
  },
  suma_netto: NNUM,
  suma_vat: NNUM,
  suma_brutto: NNUM,
  do_zaplaty: NNUM,
  pewnosc: { type: 'number' },
  uwagi: NSTR,
});

const MODEL_PRIMARY = 'claude-haiku-4-5';
const MODEL_FALLBACK = 'claude-sonnet-5';

/**
 * Buduje body żądania POST /v1/messages.
 * mediaType: application/pdf | image/jpeg | image/png | image/webp | image/gif
 */
function buildClaudeRequest({ base64, mediaType, model }) {
  const isPdf = mediaType === 'application/pdf';
  const fileBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };

  const outputConfig = { format: { type: 'json_schema', schema: EXTRACTION_SCHEMA } };
  // Haiku 4.5 nie obsługuje parametru effort; na Sonnet 5 ograniczamy myślenie,
  // bo to przepisywanie danych, nie rozumowanie.
  if (model !== MODEL_PRIMARY) outputConfig.effort = 'medium';

  return {
    model,
    max_tokens: 16000,
    system: EXTRACTION_SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: [fileBlock, { type: 'text', text: EXTRACTION_USER_PROMPT }] },
    ],
    output_config: outputConfig,
  };
}

// "" -> null w całym obiekcie (pola tekstowe bez wartości)
function emptyToNull(value) {
  if (value === '') return null;
  if (Array.isArray(value)) return value.map(emptyToNull);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = emptyToNull(v);
    return out;
  }
  return value;
}

/**
 * Wyciąga dane z odpowiedzi API. Rzuca błąd, gdy odpowiedź nie nadaje się do użycia.
 */
function parseClaudeResponse(response) {
  if (!response || !Array.isArray(response.content)) {
    throw new Error('Nieprawidłowa odpowiedź API Claude: ' + JSON.stringify(response).slice(0, 500));
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('Odpowiedź Claude ucięta (max_tokens) — dokument zbyt długi.');
  }
  if (response.stop_reason === 'refusal') {
    throw new Error('Claude odmówił przetworzenia dokumentu.');
  }
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Brak bloku tekstowego w odpowiedzi Claude.');
  const data = emptyToNull(JSON.parse(textBlock.text));
  return {
    data,
    model: response.model,
    usage: response.usage || {},
  };
}

// Koszt w USD wg cennika (za 1 mln tokenów) — do logowania w rejestrze.
const MODEL_PRICING = {
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
  'claude-sonnet-5': { input: 2.0, output: 10.0 },
};

function estimateCostUsd(model, usage) {
  const key = Object.keys(MODEL_PRICING).find((m) => (model || '').startsWith(m));
  if (!key || !usage) return null;
  const p = MODEL_PRICING[key];
  const cost = ((usage.input_tokens || 0) * p.input + (usage.output_tokens || 0) * p.output) / 1e6;
  return Math.round(cost * 100000) / 100000;
}

// @export
module.exports = {
  EXTRACTION_SYSTEM_PROMPT,
  EXTRACTION_SCHEMA,
  MODEL_PRIMARY,
  MODEL_FALLBACK,
  MAX_UNION_FIELDS,
  emptyToNull,
  buildClaudeRequest,
  parseClaudeResponse,
  estimateCostUsd,
};
