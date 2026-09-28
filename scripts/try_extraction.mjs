#!/usr/bin/env node
// Test odczytu prawdziwym modelem Claude — ten sam prompt, schemat i walidacja co w n8n.
//
//   export ANTHROPIC_API_KEY=...        (albo: ant auth login)
//   npm run try-extraction                       # wszystkie pliki z samples/out
//   npm run try-extraction -- ścieżka/do/faktury.pdf
//   npm run try-extraction -- --model claude-sonnet-5 plik.jpg
//
// Koszt: ok. 1–3 gr za dokument (Haiku 4.5).

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { buildClaudeRequest, MODEL_PRIMARY, MODEL_FALLBACK, estimateCostUsd } = require(join(ROOT, 'src/extraction.js'));
const { validateDocument, fmtGr, toGr } = require(join(ROOT, 'src/validate.js'));
const { buildFileName } = require(join(ROOT, 'src/filename.js'));

const MEDIA = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

const args = process.argv.slice(2);
let forcedModel = null;
const mi = args.indexOf('--model');
if (mi >= 0) {
  forcedModel = args[mi + 1];
  args.splice(mi, 2);
}
let files = args;
if (files.length === 0) {
  const dir = join(ROOT, 'samples/out');
  if (!existsSync(dir)) {
    console.error('Brak samples/out — najpierw: .venv/bin/python samples/generate_samples.py');
    process.exit(1);
  }
  files = readdirSync(dir).filter((f) => MEDIA[extname(f).toLowerCase()]).sort().map((f) => join(dir, f));
}

const client = new Anthropic();

async function extract(file, model) {
  const mediaType = MEDIA[extname(file).toLowerCase()];
  const body = buildClaudeRequest({ base64: readFileSync(file).toString('base64'), mediaType, model });
  const t0 = Date.now();
  const response = await client.messages.create(body);
  if (response.stop_reason !== 'end_turn') throw new Error(`stop_reason=${response.stop_reason}`);
  const text = response.content.find((b) => b.type === 'text');
  return { doc: JSON.parse(text.text), usage: response.usage, model: response.model, ms: Date.now() - t0 };
}

let totalCost = 0;
for (const file of files) {
  console.log(`\n━━━ ${basename(file)}`);
  try {
    let model = forcedModel || MODEL_PRIMARY;
    let r = await extract(file, model);
    let v = validateDocument(r.doc, { nipFirmy: process.env.NIP_FIRMY || '' });
    let cost = estimateCostUsd(r.model, r.usage) || 0;
    if (!forcedModel && v.needsRetry) {
      console.log(`  ${r.model}: ${v.errors.length} błędów / pewność ${r.doc.pewnosc} → ponawiam modelem ${MODEL_FALLBACK}`);
      r = await extract(file, MODEL_FALLBACK);
      v = validateDocument(r.doc, { nipFirmy: process.env.NIP_FIRMY || '' });
      cost += estimateCostUsd(r.model, r.usage) || 0;
    }
    totalCost += cost;
    const d = r.doc;
    console.log(`  model: ${r.model} (${r.ms} ms, ${r.usage.input_tokens} in / ${r.usage.output_tokens} out, ~${cost.toFixed(4)} USD)`);
    console.log(`  ${d.typ_dokumentu} ${d.numer} z ${d.data_wystawienia} | ${d.sprzedawca?.nazwa} NIP ${d.sprzedawca?.nip}`);
    console.log(`  pozycji: ${d.pozycje.length} | netto ${fmtGr(toGr(d.suma_netto))} VAT ${fmtGr(toGr(d.suma_vat))} brutto ${fmtGr(toGr(d.suma_brutto))} | pewność ${d.pewnosc}`);
    console.log(`  nowa nazwa: ${buildFileName(d, { originalName: basename(file), prefix: v.ok ? '' : 'SPRAWDZ' })}`);
    console.log(v.ok ? '  ✅ OK → archiwum' : '  ⚠️  DO WERYFIKACJI:');
    v.errors.forEach((e) => console.log(`     ✗ ${e.message}`));
    v.warnings.forEach((w) => console.log(`     ! ${w.message}`));
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      console.error('  Nieprawidłowy klucz API — ustaw ANTHROPIC_API_KEY.');
      process.exit(1);
    } else if (error instanceof Anthropic.RateLimitError) {
      console.error('  Limit zapytań — spróbuj za chwilę.');
    } else if (error instanceof Anthropic.APIError) {
      console.error(`  Błąd API ${error.status}: ${error.message}`);
    } else {
      console.error(`  Błąd: ${error.message}`);
    }
  }
}
console.log(`\nŁączny koszt: ~${totalCost.toFixed(4)} USD`);
