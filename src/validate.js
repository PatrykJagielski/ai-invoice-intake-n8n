// Deterministyczna walidacja odczytanego dokumentu.
// Wszystkie obliczenia w groszach (liczby całkowite) — bez błędów zmiennoprzecinkowych.
// Wklejany do węzła Code w n8n przez scripts/build_workflows.mjs.

const DEFAULT_VALIDATION_OPTIONS = {
  tolLineGr: 2, // tolerancja zaokrągleń na pozycji (ilość × cena)
  tolDocGr: 5, // tolerancja na poziomie dokumentu (sumy, tabela VAT)
  minPewnosc: 0.8,
  nipFirmy: '', // NIP naszej firmy — ostrzeżenie, gdy dokument wystawiono na inny podmiot
  existingKeys: [], // klucze dokumentów już obecnych w rejestrze (wykrywanie duplikatów)
  today: null, // 'RRRR-MM-DD' — do testów; domyślnie bieżąca data
};

const PL_VAT_RATES = { '23': 23, '8': 8, '5': 5, '0': 0, zw: 0, np: 0, oo: 0 };

function toGr(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function fmtGr(gr) {
  if (gr === null || gr === undefined) return '—';
  const sign = gr < 0 ? '-' : '';
  const abs = Math.abs(gr);
  const zl = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${sign}${zl},${String(abs % 100).padStart(2, '0')}`;
}

function normalizeRate(rate) {
  if (rate === null || rate === undefined) return null;
  let r = String(rate).trim().toLowerCase().replace('%', '').replace(',', '.');
  if (r === 'zw.' || r === 'zwol' || r === 'zwolniona') r = 'zw';
  if (r === 'n.p.' || r === 'np.' || r === 'nie podlega') r = 'np';
  if (r === 'o.o.' || r === 'oo.') r = 'oo';
  const num = Number(r);
  if (Number.isFinite(num)) {
    // 0.23 -> 23
    const pct = num > 0 && num < 1 ? num * 100 : num;
    return String(Math.round(pct * 100) / 100);
  }
  return r;
}

function rateValue(rate) {
  if (rate in PL_VAT_RATES) return PL_VAT_RATES[rate];
  const n = Number(rate);
  return Number.isFinite(n) ? n : null;
}

function normalizeNip(nip) {
  if (!nip) return { digits: '', prefix: '' };
  const s = String(nip).toUpperCase().replace(/[\s-]/g, '');
  const m = s.match(/^([A-Z]{2})?(.*)$/);
  return { prefix: m[1] || '', digits: m[2].replace(/[^0-9A-Z]/g, '') };
}

function isValidPlNip(digits) {
  if (!/^\d{10}$/.test(digits)) return false;
  const w = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const sum = w.reduce((acc, wi, i) => acc + wi * Number(digits[i]), 0);
  const ctrl = sum % 11;
  return ctrl !== 10 && ctrl === Number(digits[9]);
}

function isPolish(podmiot, nipPrefix) {
  const kraj = (podmiot && podmiot.kraj ? String(podmiot.kraj) : '').toUpperCase();
  if (nipPrefix && nipPrefix !== 'PL') return false;
  return !kraj || kraj === 'PL' || kraj === 'POLSKA';
}

function isIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function documentKey(doc) {
  const { digits } = normalizeNip(doc && doc.sprzedawca && doc.sprzedawca.nip);
  const numer = String((doc && doc.numer) || '')
    .toUpperCase()
    .replace(/\s+/g, '');
  return `${digits || 'BRAK-NIP'}|${numer || 'BRAK-NUMERU'}`;
}

/**
 * Główna funkcja walidacji.
 * Zwraca { ok, errors[], warnings[], needsRetry, key, totals }.
 * errors/warnings: { code, message, retryable }
 */
function validateDocument(doc, userOptions) {
  const opt = Object.assign({}, DEFAULT_VALIDATION_OPTIONS, userOptions || {});
  const errors = [];
  const warnings = [];
  const err = (code, message, retryable = true) => errors.push({ code, message, retryable });
  const warn = (code, message) => warnings.push({ code, message, retryable: false });

  if (!doc || typeof doc !== 'object') {
    err('BRAK_DANYCH', 'Brak odczytanych danych dokumentu.');
    return { ok: false, errors, warnings, needsRetry: true, key: null, totals: null };
  }

  const typ = doc.typ_dokumentu;
  const isInvoice = typ === 'FAKTURA' || typ === 'FAKTURA_KOREKTA';
  const isKorekta = typ === 'FAKTURA_KOREKTA';
  const pozycje = Array.isArray(doc.pozycje) ? doc.pozycje : [];
  const podsumowanie = Array.isArray(doc.podsumowanie_vat) ? doc.podsumowanie_vat : [];

  // --- 1. Typ i pola wymagane -------------------------------------------------
  if (!typ || typ === 'INNY') {
    err('TYP_NIEROZPOZNANY', 'Nie rozpoznano typu dokumentu (FV / WZ / zamówienie).', false);
  }
  if (!doc.numer) err('BRAK_NUMERU', 'Brak numeru dokumentu.');
  if (!doc.data_wystawienia) err('BRAK_DATY', 'Brak daty wystawienia.');
  if (!doc.sprzedawca || !doc.sprzedawca.nazwa) err('BRAK_KONTRAHENTA', 'Brak nazwy kontrahenta (sprzedawcy/dostawcy).');

  if (isInvoice || typ === 'PARAGON') {
    if (toGr(doc.suma_brutto) === null) err('BRAK_SUMY', 'Brak kwoty brutto do zapłaty w podsumowaniu.');
  }
  if (isInvoice && pozycje.length === 0) err('BRAK_POZYCJI', 'Faktura nie zawiera żadnych odczytanych pozycji.');
  if (typ === 'WZ' || typ === 'ZAMOWIENIE') {
    if (pozycje.length === 0) err('BRAK_POZYCJI', 'Dokument nie zawiera żadnych odczytanych pozycji.');
    pozycje.forEach((p, i) => {
      const q = Number(p.ilosc);
      if (!p.ilosc || !Number.isFinite(q) || q === 0) {
        err('BRAK_ILOSCI', `Pozycja ${p.lp || i + 1} („${p.nazwa}”): brak ilości.`);
      }
    });
  }

  // --- 2. Daty ------------------------------------------------------------------
  const today = opt.today || new Date().toISOString().slice(0, 10);
  for (const field of ['data_wystawienia', 'data_sprzedazy', 'termin_platnosci']) {
    const v = doc[field];
    if (v && !isIsoDate(v)) err('ZLA_DATA', `Nieprawidłowa data w polu ${field}: „${v}”.`);
  }
  if (isIsoDate(doc.data_wystawienia)) {
    const days = (Date.parse(doc.data_wystawienia) - Date.parse(today)) / 86400000;
    if (days > 1) warn('DATA_PRZYSZLA', `Data wystawienia ${doc.data_wystawienia} jest w przyszłości.`);
    if (days < -365) warn('DATA_STARA', `Data wystawienia ${doc.data_wystawienia} jest starsza niż rok.`);
  }

  // --- 3. NIP -------------------------------------------------------------------
  const seller = normalizeNip(doc.sprzedawca && doc.sprzedawca.nip);
  if (isInvoice) {
    if (!seller.digits) {
      err('BRAK_NIP', 'Brak NIP sprzedawcy.');
    } else if (isPolish(doc.sprzedawca, seller.prefix)) {
      if (!isValidPlNip(seller.digits)) err('ZLY_NIP', `NIP sprzedawcy ${seller.digits} ma błędną sumę kontrolną.`);
    } else {
      warn('KONTRAHENT_ZAGRANICZNY', `Sprzedawca zagraniczny (${seller.prefix || doc.sprzedawca.kraj} ${seller.digits}) — sprawdź rodzaj transakcji (WNT/import usług).`);
    }
  } else if (seller.digits && isPolish(doc.sprzedawca, seller.prefix) && !isValidPlNip(seller.digits)) {
    warn('ZLY_NIP', `NIP kontrahenta ${seller.digits} ma błędną sumę kontrolną.`);
  }
  const buyer = normalizeNip(doc.nabywca && doc.nabywca.nip);
  if (buyer.digits && isPolish(doc.nabywca, buyer.prefix) && !isValidPlNip(buyer.digits)) {
    warn('ZLY_NIP_NABYWCY', `NIP nabywcy ${buyer.digits} ma błędną sumę kontrolną.`);
  }
  const nipFirmy = normalizeNip(opt.nipFirmy).digits;
  if (isInvoice && nipFirmy && buyer.digits && buyer.digits !== nipFirmy) {
    warn('INNY_NABYWCA', `Nabywca na fakturze (NIP ${buyer.digits}) to nie nasza firma (NIP ${nipFirmy}).`);
  }

  // --- 4. Waluta, pewność ----------------------------------------------------
  if (doc.waluta && String(doc.waluta).toUpperCase() !== 'PLN') {
    warn('WALUTA_OBCA', `Dokument w walucie ${doc.waluta} — wymaga przeliczenia kursem NBP.`);
  }
  const pewnosc = Number(doc.pewnosc);
  const lowConfidence = Number.isFinite(pewnosc) && pewnosc < opt.minPewnosc;
  if (lowConfidence) warn('NISKA_PEWNOSC', `Model ocenił pewność odczytu na ${pewnosc} (< ${opt.minPewnosc}).`);

  // --- 5. Pozycje: ilość × cena, netto + VAT = brutto -------------------------
  const byRate = {}; // stawka -> { netto, vat, brutto, nettoKnown, bruttoKnown }
  let linesNetto = 0;
  let linesBrutto = 0;
  let allLinesHaveNetto = pozycje.length > 0;
  let allLinesHaveBrutto = pozycje.length > 0;
  let anyAmounts = false;

  pozycje.forEach((p, i) => {
    const label = `Pozycja ${p.lp || i + 1} („${String(p.nazwa || '').slice(0, 40)}”)`;
    const netto = toGr(p.wartosc_netto);
    const vat = toGr(p.kwota_vat);
    const brutto = toGr(p.wartosc_brutto);
    const rate = normalizeRate(p.stawka_vat);
    const qty = Number(p.ilosc);
    const price = p.cena_netto === null || p.cena_netto === undefined ? null : Number(p.cena_netto);

    if (netto !== null || brutto !== null) anyAmounts = true;
    if (netto === null) allLinesHaveNetto = false;
    else linesNetto += netto;
    if (brutto === null) allLinesHaveBrutto = false;
    else linesBrutto += brutto;

    if (netto !== null && price !== null && Number.isFinite(price) && Number.isFinite(qty) && p.ilosc !== null) {
      const expected = Math.round(qty * price * 100);
      if (Math.abs(expected - netto) > opt.tolLineGr) {
        err('POZYCJA_ILOSC_CENA', `${label}: ${qty} × ${fmtGr(Math.round(price * 100))} = ${fmtGr(expected)}, a wartość netto na dokumencie to ${fmtGr(netto)}.`);
      }
    }
    if (netto !== null && vat !== null && brutto !== null && Math.abs(netto + vat - brutto) > opt.tolLineGr) {
      err('POZYCJA_BRUTTO', `${label}: netto ${fmtGr(netto)} + VAT ${fmtGr(vat)} ≠ brutto ${fmtGr(brutto)}.`);
    }
    if (rate !== null && rateValue(rate) === null) {
      warn('NIEZNANA_STAWKA', `${label}: nierozpoznana stawka VAT „${p.stawka_vat}”.`);
    } else if (rate !== null && !(rate in PL_VAT_RATES)) {
      warn('STAWKA_NIETYPOWA', `${label}: stawka VAT ${rate}% nie jest stawką krajową.`);
    }
    if (isInvoice && rate === null && (netto !== null || brutto !== null)) {
      err('BRAK_STAWKI', `${label}: brak stawki VAT.`);
    }

    if (rate !== null) {
      const g = (byRate[rate] = byRate[rate] || { netto: 0, vat: 0, brutto: 0, nettoKnown: true, bruttoKnown: true });
      if (netto === null) g.nettoKnown = false;
      else g.netto += netto;
      if (brutto === null) g.bruttoKnown = false;
      else g.brutto += brutto;
      if (vat !== null) g.vat += vat;
    }
  });

  // --- 6. Podsumowanie dokumentu (weryfikacja bezwarunkowa) --------------------
  const sumaNetto = toGr(doc.suma_netto);
  const sumaVat = toGr(doc.suma_vat);
  const sumaBrutto = toGr(doc.suma_brutto);
  const hasSummaryAmounts = sumaNetto !== null || sumaBrutto !== null;
  // WZ / zamówienie bez kwot: sprawdzamy tylko ilości.
  const checkMath = isInvoice || typ === 'PARAGON' || anyAmounts || hasSummaryAmounts;

  if (checkMath) {
    // 6a. Suma pozycji vs podsumowanie dokumentu
    if (allLinesHaveNetto && sumaNetto !== null) {
      if (Math.abs(linesNetto - sumaNetto) > opt.tolDocGr) {
        err('SUMA_NETTO', `Suma netto pozycji ${fmtGr(linesNetto)} ≠ netto w podsumowaniu ${fmtGr(sumaNetto)} (różnica ${fmtGr(linesNetto - sumaNetto)}).`);
      }
    } else if (allLinesHaveBrutto && sumaBrutto !== null) {
      if (Math.abs(linesBrutto - sumaBrutto) > opt.tolDocGr) {
        err('SUMA_BRUTTO_POZYCJI', `Suma brutto pozycji ${fmtGr(linesBrutto)} ≠ brutto w podsumowaniu ${fmtGr(sumaBrutto)} (różnica ${fmtGr(linesBrutto - sumaBrutto)}).`);
      }
    } else if (pozycje.length > 0 && isInvoice) {
      err('POZYCJE_BEZ_KWOT', 'Nie da się zsumować pozycji — brak wartości netto/brutto na części pozycji.');
    }

    if (allLinesHaveBrutto && sumaBrutto !== null && allLinesHaveNetto && sumaNetto !== null) {
      if (Math.abs(linesBrutto - sumaBrutto) > opt.tolDocGr) {
        err('SUMA_BRUTTO_POZYCJI', `Suma brutto pozycji ${fmtGr(linesBrutto)} ≠ brutto w podsumowaniu ${fmtGr(sumaBrutto)}.`);
      }
    }

    // 6b. netto + VAT = brutto dla całego dokumentu
    if (sumaNetto !== null && sumaVat !== null && sumaBrutto !== null) {
      if (Math.abs(sumaNetto + sumaVat - sumaBrutto) > 1) {
        err('SUMA_NETTO_VAT_BRUTTO', `Podsumowanie: netto ${fmtGr(sumaNetto)} + VAT ${fmtGr(sumaVat)} ≠ brutto ${fmtGr(sumaBrutto)}.`);
      }
    } else if (isInvoice && (sumaNetto === null || sumaVat === null)) {
      warn('NIEPELNE_PODSUMOWANIE', 'Podsumowanie nie zawiera osobno kwot netto i VAT.');
    }

    // 6c. Tabela VAT wg stawek
    if (podsumowanie.length > 0) {
      let tNetto = 0;
      let tVat = 0;
      let tBrutto = 0;
      let tNettoOk = true;
      let tVatOk = true;
      let tBruttoOk = true;
      const seenRates = new Set();

      podsumowanie.forEach((row) => {
        const rate = normalizeRate(row.stawka_vat);
        seenRates.add(rate);
        const n = toGr(row.netto);
        const v = toGr(row.vat);
        const b = toGr(row.brutto);
        if (n === null) tNettoOk = false;
        else tNetto += n;
        if (v === null) tVatOk = false;
        else tVat += v;
        if (b === null) tBruttoOk = false;
        else tBrutto += b;

        if (n !== null && v !== null && b !== null && Math.abs(n + v - b) > 1) {
          err('VAT_WIERSZ', `Tabela VAT, stawka ${rate}: netto ${fmtGr(n)} + VAT ${fmtGr(v)} ≠ brutto ${fmtGr(b)}.`);
        }
        const rv = rateValue(rate);
        if (n !== null && v !== null && rv !== null) {
          // VAT liczony od netto (lub od brutto — wtedy dopuszczamy większą różnicę zaokrągleń)
          const expectedVat = Math.round((n * rv) / 100);
          const tol = doc.metoda_liczenia_vat === 'od_brutto' ? opt.tolDocGr : Math.max(1, opt.tolLineGr);
          if (Math.abs(expectedVat - v) > tol) {
            err('VAT_STAWKA', `Tabela VAT, stawka ${rate}: ${rv}% od ${fmtGr(n)} to ${fmtGr(expectedVat)}, a na dokumencie VAT = ${fmtGr(v)}.`);
          }
        }
        const g = byRate[rate];
        if (g && n !== null && g.nettoKnown && Math.abs(g.netto - n) > opt.tolDocGr) {
          err('VAT_POZYCJE', `Stawka ${rate}: suma netto pozycji ${fmtGr(g.netto)} ≠ netto w tabeli VAT ${fmtGr(n)}.`);
        } else if (g && b !== null && !g.nettoKnown && g.bruttoKnown && Math.abs(g.brutto - b) > opt.tolDocGr) {
          err('VAT_POZYCJE', `Stawka ${rate}: suma brutto pozycji ${fmtGr(g.brutto)} ≠ brutto w tabeli VAT ${fmtGr(b)}.`);
        }
      });

      Object.keys(byRate).forEach((rate) => {
        if (!seenRates.has(rate)) {
          err('VAT_BRAK_STAWKI', `Pozycje zawierają stawkę ${rate}, której nie ma w tabeli podsumowania VAT.`);
        }
      });

      if (tNettoOk && sumaNetto !== null && Math.abs(tNetto - sumaNetto) > opt.tolDocGr) {
        err('VAT_SUMA_NETTO', `Suma netto tabeli VAT ${fmtGr(tNetto)} ≠ netto dokumentu ${fmtGr(sumaNetto)}.`);
      }
      if (tVatOk && sumaVat !== null && Math.abs(tVat - sumaVat) > opt.tolDocGr) {
        err('VAT_SUMA_VAT', `Suma VAT tabeli ${fmtGr(tVat)} ≠ VAT dokumentu ${fmtGr(sumaVat)}.`);
      }
      if (tBruttoOk && sumaBrutto !== null && Math.abs(tBrutto - sumaBrutto) > opt.tolDocGr) {
        err('VAT_SUMA_BRUTTO', `Suma brutto tabeli VAT ${fmtGr(tBrutto)} ≠ brutto dokumentu ${fmtGr(sumaBrutto)}.`);
      }
    } else if (isInvoice && sumaNetto !== null && sumaVat !== null) {
      // Brak tabeli VAT: VAT dokumentu musi się zgadzać z VAT wyliczonym z pozycji.
      let expectedVat = 0;
      let computable = true;
      Object.keys(byRate).forEach((rate) => {
        const rv = rateValue(rate);
        if (rv === null || !byRate[rate].nettoKnown) computable = false;
        else expectedVat += Math.round((byRate[rate].netto * rv) / 100);
      });
      if (computable && Object.keys(byRate).length > 0 && Math.abs(expectedVat - sumaVat) > opt.tolDocGr) {
        err('VAT_WYLICZONY', `VAT wyliczony z pozycji ${fmtGr(expectedVat)} ≠ VAT na dokumencie ${fmtGr(sumaVat)}.`);
      }
    }

    // 6d. Do zapłaty
    const doZaplaty = toGr(doc.do_zaplaty);
    if (doZaplaty !== null && sumaBrutto !== null && doZaplaty !== sumaBrutto && !isKorekta) {
      warn('DO_ZAPLATY', `Kwota do zapłaty ${fmtGr(doZaplaty)} różni się od brutto ${fmtGr(sumaBrutto)} (zaliczka? częściowa płatność?).`);
    }
    if (!isKorekta && sumaBrutto !== null && sumaBrutto < 0) {
      warn('KWOTA_UJEMNA', 'Ujemna kwota brutto na dokumencie, który nie jest korektą.');
    }
  }

  // --- 7. Duplikaty ---------------------------------------------------------------
  const key = documentKey(doc);
  if (doc.numer && (opt.existingKeys || []).includes(key)) {
    err('DUPLIKAT', `Dokument ${doc.numer} od kontrahenta NIP ${seller.digits || '—'} jest już w rejestrze.`, false);
  }

  const needsRetry = errors.some((e) => e.retryable) || lowConfidence;
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    needsRetry,
    key,
    totals: {
      pozycje_netto: allLinesHaveNetto ? linesNetto / 100 : null,
      pozycje_brutto: allLinesHaveBrutto ? linesBrutto / 100 : null,
    },
  };
}

// @export
module.exports = {
  DEFAULT_VALIDATION_OPTIONS,
  validateDocument,
  documentKey,
  isValidPlNip,
  normalizeNip,
  normalizeRate,
  rateValue,
  toGr,
  fmtGr,
};
