const test = require('node:test');
const assert = require('node:assert/strict');
const ex = require('../src/extraction.js');

function allObjectsStrict(schema, path = '$') {
  if (schema.anyOf) return schema.anyOf.forEach((s) => allObjectsStrict(s, path));
  if (schema.type === 'object') {
    assert.equal(schema.additionalProperties, false, path);
    assert.deepEqual(schema.required.sort(), Object.keys(schema.properties).sort(), path);
    Object.entries(schema.properties).forEach(([k, s]) => allObjectsStrict(s, `${path}.${k}`));
  }
  if (schema.type === 'array') allObjectsStrict(schema.items, `${path}[]`);
}

test('schemat spełnia wymagania structured outputs', () => {
  allObjectsStrict(ex.EXTRACTION_SCHEMA);
});

test('żądanie dla PDF (Haiku) i obrazu (Sonnet)', () => {
  const pdf = ex.buildClaudeRequest({ base64: 'AAA', mediaType: 'application/pdf', model: ex.MODEL_PRIMARY });
  assert.equal(pdf.messages[0].content[0].type, 'document');
  assert.equal(pdf.output_config.effort, undefined);
  assert.equal(pdf.output_config.format.type, 'json_schema');
  const img = ex.buildClaudeRequest({ base64: 'AAA', mediaType: 'image/jpeg', model: ex.MODEL_FALLBACK });
  assert.equal(img.messages[0].content[0].type, 'image');
  assert.equal(img.output_config.effort, 'medium');
});

test('parsowanie odpowiedzi i obsługa błędów', () => {
  const r = ex.parseClaudeResponse({ model: 'claude-haiku-4-5', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"numer":"1"}' }], usage: { input_tokens: 2000, output_tokens: 800 } });
  assert.equal(r.data.numer, '1');
  assert.equal(ex.estimateCostUsd(r.model, r.usage), 0.006);
  assert.throws(() => ex.parseClaudeResponse({ stop_reason: 'max_tokens', content: [] }), /max_tokens/);
});

function countUnions(schema) {
  let n = schema.anyOf || Array.isArray(schema.type) ? 1 : 0;
  if (schema.properties) Object.values(schema.properties).forEach((s) => (n += countUnions(s)));
  if (schema.items) n += countUnions(schema.items);
  return n;
}

test('schemat mieści się w limicie pól union API (max 16)', () => {
  const n = countUnions(ex.EXTRACTION_SCHEMA);
  assert.ok(n <= ex.MAX_UNION_FIELDS, `pól union: ${n}`);
});

test('puste teksty z odpowiedzi zamieniane na null', () => {
  const r = ex.parseClaudeResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ numer: '', sprzedawca: { nip: '' }, pozycje: [{ stawka_vat: '', ilosc: 2 }] }) }] });
  assert.equal(r.data.numer, null);
  assert.equal(r.data.sprzedawca.nip, null);
  assert.equal(r.data.pozycje[0].stawka_vat, null);
  assert.equal(r.data.pozycje[0].ilosc, 2);
});
