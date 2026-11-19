import pymupdf, json, re, csv, sys

PDF = r"C:\Users\eyeamfresh\Downloads\DOKUMENT.pdf"
doc = pymupdf.open(PDF)

def fnum(s):
    s = s.strip().replace(".", "").replace(",", ".")
    try:
        return float(s)
    except Exception:
        return None

rows = []
for pno, page in enumerate(doc, 1):
    words = page.get_text("words")
    # group by y (round to 0.5)
    lines = {}
    for w in words:
        key = round(w[1] / 2.0) * 2.0
        lines.setdefault(key, []).append(w)
    for key in sorted(lines):
        ws = sorted(lines[key], key=lambda w: w[0])
        material = [w for w in ws if 15 <= w[0] <= 55]
        if not material:
            continue
        mat = material[0][4]
        if not re.fullmatch(r"\d{4,}", mat):
            continue
        desc = " ".join(w[4] for w in ws if 60 <= w[0] <= 250)
        hier = " ".join(w[4] for w in ws if 250 <= w[0] <= 310)
        onhand = " ".join(w[4] for w in ws if 300 <= w[2] <= 346)
        unit = " ".join(w[4] for w in ws if 347 <= w[0] <= 370)
        price = " ".join(w[4] for w in ws if 370 <= w[2] <= 412)
        crcy = " ".join(w[4] for w in ws if 412 <= w[0] <= 437)
        crcy2 = " ".join(w[4] for w in ws if 437 <= w[0] <= 460)
        packsize = " ".join(w[4] for w in ws if 468 <= w[2] <= 492)
        minstock = " ".join(w[4] for w in ws if 508 <= w[2] <= 532)
        maxstock = " ".join(w[4] for w in ws if 543 <= w[2] <= 568)
        su = " ".join(w[4] for w in ws if 568 <= w[0] <= 584)
        totcons = " ".join(w[4] for w in ws if 584 <= w[2] <= 633)
        bun = " ".join(w[4] for w in ws if 633 <= w[0] <= 653)
        date = " ".join(w[4] for w in ws if 653 <= w[0] <= 706)
        stat = " ".join(w[4] for w in ws if 706 <= w[0] <= 790)
        rows.append({
            "material": mat,
            "description": desc,
            "prodHier": hier,
            "onHand": fnum(onhand),
            "unit": unit,
            "unitPrice": fnum(price),
            "currency": crcy or "USD",
            "packSize": fnum(packsize),
            "packMin": fnum(minstock),
            "packMax": fnum(maxstock),
            "suUnit": su,
            "totalConsumed": fnum(totcons),
            "bUn": bun,
            "lastMovement": date,
            "salesStat": stat,
            "sourcePage": pno,
        })

print("rows:", len(rows))
print("first:", json.dumps(rows[0], ensure_ascii=False))
print("last :", json.dumps(rows[-1], ensure_ascii=False))
bad = [r for r in rows if not r["description"] or r["onHand"] is None or r["unitPrice"] is None]
print("suspicious:", len(bad))
for r in bad[:10]:
    print("  ", json.dumps(r, ensure_ascii=False))

with open(r"C:\Users\eyeamfresh\Desktop\nocodbweb\stock_rows.json", "w", encoding="utf-8") as f:
    json.dump(rows, f, ensure_ascii=False, indent=1)

with open(r"C:\Users\eyeamfresh\Desktop\nocodbweb\stock_rows.csv", "w", encoding="utf-8-sig", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
    w.writeheader()
    w.writerows(rows)

mats = {r["material"] for r in rows}
print("unique materials:", len(mats))
print("units:", sorted({r["unit"] for r in rows}))
print("hier count:", len({r["prodHier"] for r in rows}), sorted({r["prodHier"] for r in rows})[:12])
print("no date:", sum(1 for r in rows if not r["lastMovement"]))
