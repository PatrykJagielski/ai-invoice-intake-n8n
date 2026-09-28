#!/usr/bin/env python3
"""Generuje przykładowe dokumenty do testów obiegu (PDF + „skan” JPG).

Uruchomienie:  .venv/bin/python samples/generate_samples.py
Wynik:         samples/out/*.pdf, samples/out/*.jpg

Zestaw:
  01_FV_poprawna_3_stawki.pdf   -> powinna trafić do archiwum
  02_FV_bledna_suma.pdf         -> suma netto w podsumowaniu się nie zgadza -> weryfikacja
  03_FV_bledny_NIP.pdf          -> zła suma kontrolna NIP sprzedawcy -> weryfikacja
  04_WZ_dostawa.pdf             -> WZ bez kwot -> archiwum
  05_ZAM_zamowienie.pdf         -> zamówienie z cenami -> archiwum
  06_FV_skan_telefon.jpg        -> zdjęcie faktury (obrót, szum) -> archiwum
"""
import os
import random
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

OUT = Path(__file__).parent / "out"

FONT_CANDIDATES = [
    ("/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
]
FONT_REGULAR, FONT_BOLD = next((r, b) for r, b in FONT_CANDIDATES if os.path.exists(r))

BUYER = {"nazwa": "Nasza Firma S.A.", "nip": "987-654-32-10", "adres": ["ul. Przykładowa 7", "09-400 Płock"]}
SELLER = {"nazwa": "Hurtownia Budowlana Łączność Sp. z o.o.", "nip": "123-456-32-18", "adres": ["ul. Magazynowa 12", "00-001 Warszawa"]}
SELLER_2 = {"nazwa": "PHU Elektro-Mix Jan Kowalski", "nip": "555-555-55-55", "adres": ["ul. Fabryczna 3", "30-001 Kraków"]}

D = lambda s: Decimal(str(s))
Q = Decimal("0.01")


def r2(x):
    return x.quantize(Q, rounding=ROUND_HALF_UP)


def pl(x):
    """1234.5 -> '1 234,50'"""
    s = f"{r2(D(x)):,.2f}"
    return s.replace(",", " ").replace(".", ",")


def qty(x):
    return f"{x:g}".replace(".", ",")


def invoice_totals(items):
    """Liczy wartości jak program fakturowy: VAT od sumy netto w stawce."""
    lines, by_rate = [], {}
    for it in items:
        netto = r2(D(it["ilosc"]) * D(it["cena"]))
        rate = it["vat"]
        pct = D(rate) if rate.isdigit() else D(0)
        vat = r2(netto * pct / 100)
        lines.append({**it, "netto": netto, "vat_kw": vat, "brutto": netto + vat})
        g = by_rate.setdefault(rate, D(0))
        by_rate[rate] = g + netto
    table = []
    for rate, netto in sorted(by_rate.items(), key=lambda kv: -int(kv[0]) if kv[0].isdigit() else 1):
        pct = D(rate) if rate.isdigit() else D(0)
        vat = r2(netto * pct / 100)
        table.append({"stawka": rate, "netto": netto, "vat": vat, "brutto": netto + vat})
    sn = sum(t["netto"] for t in table)
    sv = sum(t["vat"] for t in table)
    return lines, table, {"netto": sn, "vat": sv, "brutto": sn + sv}


# --- Layout niezależny od formatu: lista operacji rysowania w mm od lewego górnego rogu ---

def layout_invoice(doc):
    ops = []
    t = lambda x, y, s, size=9, bold=False, align="left": ops.append(("text", x, y, s, size, bold, align))
    line = lambda x1, y1, x2, y2: ops.append(("line", x1, y1, x2, y2))

    t(15, 18, doc["tytul"], 16, True)
    t(15, 25, f"Nr {doc['numer']}", 12, True)
    t(195, 18, f"Data wystawienia: {doc['data']}", 9, align="right")
    if doc.get("data_sprzedazy"):
        t(195, 23, f"Data sprzedaży: {doc['data_sprzedazy']}", 9, align="right")
    if doc.get("powiazany"):
        t(195, 28, doc["powiazany"], 9, align="right")

    y = 40
    t(15, y, doc.get("etykieta_sprzedawcy", "Sprzedawca:"), 9, True)
    t(110, y, doc.get("etykieta_nabywcy", "Nabywca:"), 9, True)
    s, b = doc["sprzedawca"], doc["nabywca"]
    for i, txt in enumerate([s["nazwa"], *s["adres"], f"NIP: {s['nip']}"]):
        t(15, y + 5 + i * 4.5, txt)
    for i, txt in enumerate([b["nazwa"], *b["adres"], f"NIP: {b['nip']}"]):
        t(110, y + 5 + i * 4.5, txt)

    y = 72
    with_prices = doc.get("z_cenami", True)
    if with_prices:
        cols = [(15, "Lp.", "left"), (23, "Nazwa towaru / usługi", "left"), (105, "Ilość", "right"), (113, "J.m.", "left"),
                (140, "Cena netto", "right"), (160, "Wartość netto", "right"), (172, "VAT", "right"), (195, "Wartość brutto", "right")]
    else:
        cols = [(15, "Lp.", "left"), (23, "Nazwa towaru", "left"), (60 + 70, "Kod", "left"), (175, "Ilość", "right"), (195, "J.m.", "right")]
    line(15, y - 4, 195, y - 4)
    for x, h, al in cols:
        t(x, y, h, 8, True, al)
    line(15, y + 2, 195, y + 2)
    y += 7
    for i, it in enumerate(doc["pozycje"], 1):
        if with_prices:
            vals = [str(i), it["nazwa"], qty(it["ilosc"]), it["jm"], pl(it["cena"]), pl(it["netto"]),
                    it["vat"] + ("%" if it["vat"].isdigit() else ""), pl(it["brutto"])]
        else:
            vals = [str(i), it["nazwa"], it.get("kod", ""), qty(it["ilosc"]), it["jm"]]
        for (x, _, al), v in zip(cols, vals):
            t(x, y, v, 8.5, False, al)
        y += 5.5
    line(15, y - 2, 195, y - 2)

    if with_prices:
        y += 5
        t(110, y, "Stawka", 8, True)
        t(145, y, "Netto", 8, True, "right")
        t(170, y, "VAT", 8, True, "right")
        t(195, y, "Brutto", 8, True, "right")
        y += 5
        for row in doc["tabela_vat"]:
            t(110, y, row["stawka"] + ("%" if row["stawka"].isdigit() else ""), 8.5)
            t(145, y, pl(row["netto"]), 8.5, align="right")
            t(170, y, pl(row["vat"]), 8.5, align="right")
            t(195, y, pl(row["brutto"]), 8.5, align="right")
            y += 5
        line(110, y - 2, 195, y - 2)
        tot = doc["suma"]
        t(110, y + 2, "RAZEM", 8.5, True)
        t(145, y + 2, pl(tot["netto"]), 8.5, True, "right")
        t(170, y + 2, pl(tot["vat"]), 8.5, True, "right")
        t(195, y + 2, pl(tot["brutto"]), 8.5, True, "right")
        y += 14
        t(15, y, f"Do zapłaty: {pl(tot['brutto'])} PLN", 12, True)
        y += 6
        if doc.get("termin"):
            t(15, y, f"Forma płatności: przelew, termin: {doc['termin']}", 9)
            t(15, y + 5, "Nr konta: PL00 1234 5678 9012 3456 7890 1234", 9)
    y = 270
    line(20, y, 80, y)
    line(130, y, 190, y)
    t(50, y + 4, "wystawił(a)", 7, align="center")
    t(160, y + 4, "odebrał(a)", 7, align="center")
    return ops


def render_pdf(ops, path):
    pdfmetrics.registerFont(TTFont("Reg", FONT_REGULAR))
    pdfmetrics.registerFont(TTFont("Bold", FONT_BOLD))
    w, h = A4
    mm = 72 / 25.4
    c = canvas.Canvas(str(path), pagesize=A4)
    for op in ops:
        if op[0] == "text":
            _, x, y, s, size, bold, align = op
            c.setFont("Bold" if bold else "Reg", size)
            fn = {"left": c.drawString, "right": c.drawRightString, "center": c.drawCentredString}[align]
            fn(x * mm, h - y * mm, s)
        else:
            _, x1, y1, x2, y2 = op
            c.setLineWidth(0.5)
            c.line(x1 * mm, h - y1 * mm, x2 * mm, h - y2 * mm)
    c.save()


def render_photo(ops, path, seed=7):
    """Symulacja zdjęcia telefonem: 150 dpi, lekko szare tło, obrót, rozmycie, szum."""
    random.seed(seed)
    dpi = 150
    px = lambda v: int(v / 25.4 * dpi)
    img = Image.new("RGB", (px(210), px(297)), (244, 241, 234))
    dr = ImageDraw.Draw(img)
    fonts = {}
    for op in ops:
        if op[0] == "text":
            _, x, y, s, size, bold, align = op
            key = (size, bold)
            if key not in fonts:
                fonts[key] = ImageFont.truetype(FONT_BOLD if bold else FONT_REGULAR, int(size * dpi / 72))
            f = fonts[key]
            tw = dr.textlength(s, font=f)
            xx = px(x) - (tw if align == "right" else tw / 2 if align == "center" else 0)
            dr.text((xx, px(y) - f.size), s, font=f, fill=(35, 35, 40))
        else:
            _, x1, y1, x2, y2 = op
            dr.line((px(x1), px(y1), px(x2), px(y2)), fill=(60, 60, 60), width=1)
    img = img.rotate(-1.4, resample=Image.BICUBIC, expand=True, fillcolor=(120, 115, 105))
    img = img.filter(ImageFilter.GaussianBlur(0.6))
    noise = Image.effect_noise(img.size, 18).convert("RGB")
    img = Image.blend(img, noise, 0.08)
    img.save(path, "JPEG", quality=72)


def invoice(numer, data, items, seller=SELLER, termin="2026-10-10", break_total=None, nip_override=None):
    lines, table, suma = invoice_totals(items)
    s = dict(seller)
    if nip_override:
        s["nip"] = nip_override
    if break_total:
        suma = {k: suma[k] + D(break_total.get(k, 0)) for k in suma}
    return {"tytul": "FAKTURA VAT", "numer": numer, "data": data, "data_sprzedazy": data, "termin": termin,
            "sprzedawca": s, "nabywca": BUYER, "pozycje": lines, "tabela_vat": table, "suma": suma}


ITEMS_1 = [
    {"nazwa": "Cement portlandzki CEM II 25kg", "ilosc": 10, "jm": "szt", "cena": "25.50", "vat": "23"},
    {"nazwa": "Rękawice robocze powlekane", "ilosc": 4, "jm": "para", "cena": "12.30", "vat": "23"},
    {"nazwa": "Poradnik BHP na budowie (książka)", "ilosc": 2, "jm": "szt", "cena": "40.00", "vat": "5"},
    {"nazwa": "Catering – kanapki dla ekipy", "ilosc": 3, "jm": "szt", "cena": "3.70", "vat": "8"},
]

ITEMS_2 = [
    {"nazwa": "Przewód YDYp 3x2,5 (100 m)", "ilosc": 2, "jm": "kpl", "cena": "389.00", "vat": "23"},
    {"nazwa": "Puszka podtynkowa fi60", "ilosc": 50, "jm": "szt", "cena": "0.85", "vat": "23"},
    {"nazwa": "Wyłącznik nadprądowy B16", "ilosc": 12, "jm": "szt", "cena": "14.20", "vat": "23"},
    {"nazwa": "Usługa pomiarów elektrycznych", "ilosc": 1, "jm": "usł", "cena": "450.00", "vat": "23"},
    {"nazwa": "Transport", "ilosc": 1, "jm": "usł", "cena": "60.00", "vat": "23"},
]

ITEMS_3 = [
    {"nazwa": "Płyta g-k 12,5mm 1200x2600", "ilosc": 40, "jm": "szt", "cena": "27.90", "vat": "23"},
    {"nazwa": "Profil CW50 3m", "ilosc": 60, "jm": "szt", "cena": "9.45", "vat": "23"},
    {"nazwa": "Wkręty do g-k 3,5x25 (1000 szt)", "ilosc": 3, "jm": "op", "cena": "38.00", "vat": "23"},
]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    docs = {
        "01_FV_poprawna_3_stawki.pdf": invoice("FV/123/09/2026", "2026-09-15", ITEMS_1),
        # Błąd „drukarski”: w podsumowaniu RAZEM netto zawyżone o 36 zł (przestawione cyfry 395 -> 359 itp.)
        "02_FV_bledna_suma.pdf": invoice("FV/124/09/2026", "2026-09-17", ITEMS_3, break_total={"netto": "-36.00", "brutto": "-36.00"}),
        "03_FV_bledny_NIP.pdf": invoice("FV/125/09/2026", "2026-09-18", ITEMS_1[:2], nip_override="123-456-32-19"),
    }
    wz_items = [
        {"nazwa": "Płyta g-k 12,5mm 1200x2600", "kod": "GK-125", "ilosc": 40, "jm": "szt"},
        {"nazwa": "Profil CW50 3m", "kod": "CW-50", "ilosc": 60, "jm": "szt"},
        {"nazwa": "Wkręty do g-k 3,5x25", "kod": "WK-3525", "ilosc": 3, "jm": "op"},
    ]
    docs["04_WZ_dostawa.pdf"] = {
        "tytul": "WZ – WYDANIE ZEWNĘTRZNE", "numer": "WZ/77/09/2026", "data": "2026-09-16",
        "powiazany": "Do zamówienia: ZAM/12/2026", "etykieta_sprzedawcy": "Wydający:", "etykieta_nabywcy": "Odbiorca:",
        "sprzedawca": SELLER, "nabywca": BUYER, "pozycje": wz_items, "z_cenami": False,
    }
    zam_lines, zam_table, zam_sum = invoice_totals(ITEMS_3)
    docs["05_ZAM_zamowienie.pdf"] = {
        "tytul": "ZAMÓWIENIE", "numer": "ZAM/12/2026", "data": "2026-09-10", "etykieta_sprzedawcy": "Dostawca:",
        "etykieta_nabywcy": "Zamawiający:", "sprzedawca": SELLER, "nabywca": BUYER,
        "pozycje": zam_lines, "tabela_vat": zam_table, "suma": zam_sum,
    }
    for name, doc in docs.items():
        render_pdf(layout_invoice(doc), OUT / name)
    render_photo(layout_invoice(invoice("FV/2026/09/0412", "2026-09-19", ITEMS_2, seller=SELLER_2)), OUT / "06_FV_skan_telefon.jpg")

    for p in sorted(OUT.iterdir()):
        print(f"{p.name:34s} {p.stat().st_size / 1024:7.1f} KB")


if __name__ == "__main__":
    main()
