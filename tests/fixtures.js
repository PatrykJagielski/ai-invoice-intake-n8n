// Wspólne dane testowe: poprawna faktura z trzema stawkami VAT.
function validInvoice() {
  return {
    typ_dokumentu: 'FAKTURA',
    numer: 'FV/123/09/2026',
    data_wystawienia: '2026-09-15',
    data_sprzedazy: '2026-09-15',
    termin_platnosci: '2026-09-29',
    forma_platnosci: 'przelew',
    waluta: 'PLN',
    numer_dokumentu_powiazanego: null,
    sprzedawca: { nazwa: 'Hurtownia Budowlana Łączność Sp. z o.o.', nip: '123-456-32-18', kraj: 'PL', ulica: 'ul. Magazynowa 12', kod_pocztowy: '00-001', miasto: 'Warszawa' },
    nabywca: { nazwa: 'Nasza Firma S.A.', nip: '9876543210', kraj: 'PL', ulica: null, kod_pocztowy: null, miasto: 'Płock' },
    metoda_liczenia_vat: 'od_netto',
    pozycje: [
      { lp: 1, nazwa: 'Cement portlandzki 25kg', kod: 'CEM-25', ilosc: 10, jm: 'szt', cena_netto: 25.5, stawka_vat: '23', wartosc_netto: 255.0, kwota_vat: 58.65, wartosc_brutto: 313.65 },
      { lp: 2, nazwa: 'Rękawice robocze', kod: 'REK-01', ilosc: 4, jm: 'para', cena_netto: 12.3, stawka_vat: '23', wartosc_netto: 49.2, kwota_vat: 11.32, wartosc_brutto: 60.52 },
      { lp: 3, nazwa: 'Poradnik BHP (książka)', kod: null, ilosc: 2, jm: 'szt', cena_netto: 40.0, stawka_vat: '5', wartosc_netto: 80.0, kwota_vat: 4.0, wartosc_brutto: 84.0 },
      { lp: 4, nazwa: 'Pieczywo – catering', kod: null, ilosc: 3, jm: 'szt', cena_netto: 3.7, stawka_vat: '8', wartosc_netto: 11.1, kwota_vat: 0.89, wartosc_brutto: 11.99 },
    ],
    podsumowanie_vat: [
      { stawka_vat: '23', netto: 304.2, vat: 69.97, brutto: 374.17 },
      { stawka_vat: '8', netto: 11.1, vat: 0.89, brutto: 11.99 },
      { stawka_vat: '5', netto: 80.0, vat: 4.0, brutto: 84.0 },
    ],
    suma_netto: 395.3,
    suma_vat: 74.86,
    suma_brutto: 470.16,
    do_zaplaty: 470.16,
    pewnosc: 0.95,
    uwagi: null,
  };
}

function validWz() {
  return {
    typ_dokumentu: 'WZ',
    numer: 'WZ/77/2026',
    data_wystawienia: '2026-09-16',
    data_sprzedazy: null,
    termin_platnosci: null,
    forma_platnosci: null,
    waluta: null,
    numer_dokumentu_powiazanego: 'ZAM/12/2026',
    sprzedawca: { nazwa: 'Hurtownia Budowlana Łączność Sp. z o.o.', nip: '1234563218', kraj: 'PL', ulica: null, kod_pocztowy: null, miasto: 'Warszawa' },
    nabywca: { nazwa: 'Nasza Firma S.A.', nip: '9876543210', kraj: 'PL', ulica: null, kod_pocztowy: null, miasto: null },
    metoda_liczenia_vat: 'nieznana',
    pozycje: [
      { lp: 1, nazwa: 'Cement portlandzki 25kg', kod: 'CEM-25', ilosc: 10, jm: 'szt', cena_netto: null, stawka_vat: null, wartosc_netto: null, kwota_vat: null, wartosc_brutto: null },
      { lp: 2, nazwa: 'Rękawice robocze', kod: 'REK-01', ilosc: 4, jm: 'para', cena_netto: null, stawka_vat: null, wartosc_netto: null, kwota_vat: null, wartosc_brutto: null },
    ],
    podsumowanie_vat: [],
    suma_netto: null,
    suma_vat: null,
    suma_brutto: null,
    do_zaplaty: null,
    pewnosc: 0.9,
    uwagi: null,
  };
}

module.exports = { validInvoice, validWz, TODAY: '2026-09-28' };
