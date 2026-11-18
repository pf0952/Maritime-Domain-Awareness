"""My vessel, from her documents: a capacity plan, a stability report and a stow plan, as PDFs. Nothing here works
out stability: the figures are read off the stability report as the ship's own approved software printed them, and
the compartments and cargo off the capacity and stow plans, for the 3D picture and the motions along a route.

A vessel: { id, name, principal: {lbp, breadth, depth}, report: {figures: {key: value}, source: {key: "p. 3"}},
compartments: [{name, kind, capacity, lcg, tcg, vcg}], stow: [{name, weight, lcg, tcg, vcg, size?: [l, b, h]}],
documents: {capacity, report, stow: file names} }. Frame: x m from the aft perpendicular (+ forward), y m from the
centreline (+ starboard), z m above the baseline."""
import io
import os
import json
import re
from pathlib import Path

STORE = Path(__file__).parent.parent / "enc" / "vessels"
PDF_MOST = 60_000_000  # bytes of one document

# the stability report's figures, by the labels loading software prints them with (MACS3, CargoMax, Loadmaster and
# the like): the first pattern found wins, so the corrected (fluid) GM and KG come before the plain ones. Matched
# against a label alone, never the whole line
FIGURES = {
    "displacement": [r"^displacement$", r"^displacement\b", r"\bdispl\b\.?"],
    "deadweight": [r"^dead\s*weight$", r"^dead\s*weight\b(?!\s*res)", r"^dwt\b"],
    "draught_aft": [r"^dra(?:ugh|f)t\s*(?:at\s*)?(?:a\.?p\.?|aft)\b", r"\bdra(?:ugh|f)t\s*at\s*aft\s*perp", r"^aft\s*dra(?:ugh|f)t\b", r"^aft\s*mark\b"],
    "draught_fwd": [r"^dra(?:ugh|f)t\s*(?:at\s*)?(?:f\.?p\.?|fwd|forward|fore)\b", r"\bdra(?:ugh|f)t\s*at\s*fore\s*perp", r"^(?:fwd|forward|fore)\s*(?:dra(?:ugh|f)t|mark)\b"],
    "draught_mid": [r"^dra(?:ugh|f)t\s*(?:at\s*)?mid(?:ship)?s?\b", r"^dra(?:ugh|f)t\s*mean\b", r"^mean\s*dra(?:ugh|f)t\b", r"\bcorresponding\s*mean\s*draught"],
    "trim": [r"\btotal\s*trim\b", r"^trim\b(?!.*degree)(?!\s*(?:at|coeff|lever|/))"],
    "list": [r"^list\b", r"^heel\b"],
    "gm": [r"\bG[O0]?M\s*'", r"\bG'M\b", r"\bG[O0']?M\s*t?\s*\(?\s*(?:corr(?:ected)?|fluid|liquid)", r"\bcorr(?:ected)?\.?\s*(?:transverse\s*)?(?:metacentric\s*height\s*)?G[O0']?M", r"\bGoM\b", r"\bmetacentric\s*height\b", r"\bGMt?\b"],
    "kg": [r"\bvertical\s*centre\s*of\s*gravity\s*corr", r"\bK?G\s*'|\bKG\s*\(?\s*(?:corr(?:ected)?|fluid)", r"\bcorr(?:ected)?\.?\s*KG\b", r"^KG\b(?!.*solid)", r"\bKG\b"],
    "km": [r"\bKMt?\b", r"\btransverse\s*metacentre\b"],
    "lcg": [r"\blongitudinal\s*centre\s*of\s*gravity\b", r"^LCG\b"],
    "tcg": [r"^TCG\b"],
    "roll_period": [r"\bperiod\s*of\s*roll", r"\broll(?:ing)?\s*period\b"],
    "air_draught": [r"\bair\s*dra(?:ugh|f)t\b(?!s)", r"\b(?:signal\s*)?mast\s*top\b"],
}
# the ship's particulars, by the labels documents print them with, each with the range a ship's can be in (a number
# outside it belongs to something else on the line)
PARTICULARS = {
    "lbp": ([r"\bL\.?\s?B\.?\s?P\b\.?", r"\bL\.?\s?P\.?\s?P\b\.?", r"\blength\s*(?:b\.?\s*p\b|between\s*perp)"], (10, 500)),
    "loa": ([r"\bL\.?\s?O\.?\s?A\b\.?", r"\blength\s*over\s*all\b|\boverall\s*length\b"], (10, 500)),
    "breadth": ([r"\b(?:moulded\s*)?breadth\b(?!\s*(?:extreme|ext))", r"\bbeam\b(?!\s*seas?\b)",r"\bB\s*\.?\s*mld\b"], (2, 80)),
    "depth": ([r"\b(?:moulded\s*)?depth\b(?!\s*(?:contour|area|of\s*water))", r"\bD\s*\.?\s*mld\b"], (1, 50)),
}
NUMBER = re.compile(r"[-+]?\d[\d,]*(?:\.\d+)?")
LEADING_NUMBER = re.compile(r"^[-+]?\d[\d,]*(?:\.\d+)?")


def number(text: str) -> float:
    """A printed number: "31,812.0" and "31812" alike, and a decimal comma ("9,22")."""
    if "," in text and "." in text:
        text = text.replace(",", "")
    elif re.fullmatch(r"[-+]?\d{1,3}(,\d{3})+", text):
        text = text.replace(",", "")
    return float(text.replace(",", "."))


def cells(line: str) -> list:
    """A line's cells: runs of text split where two or more spaces part them, with where each starts and ends."""
    return [(m.start(), m.end(), m.group()) for m in re.finditer(r"\S+(?: \S+)*", line)]


def pairs(line: str) -> list:
    """(label, value) on a line however far apart they're printed: each cell with words is a label, its value the
    number at its own end ("Trim 0.6") or else the next cell that starts with a number ("71.96m.fr.AP" too)."""
    out = []
    cs = cells(line)
    for i, (_, _, text) in enumerate(cs):
        if not re.search(r"[A-Za-z]", text) or LEADING_NUMBER.match(text):
            continue
        inside = re.search(r"^(.*?[A-Za-z'\)\]:.])\s*:?\s*([-+]?\d[\d,]*(?:\.\d+)?)", text)
        if inside and len(inside.group(1)) >= 2:
            out.append((inside.group(1).strip(" :"), number(inside.group(2))))
            continue
        for _, _, after in cs[i + 1 : i + 3]:
            m = LEADING_NUMBER.match(after)
            if m:
                out.append((text.strip(" :"), number(m.group())))
                break
            if re.search(r"[A-Za-z]{3,}", after) and after.lower() not in ("tons", "deg", "degr.", "sec"):
                break  # (another label before any number: this one's value isn't on the line)
    return out


# a table's columns, by the words loading software heads them with
COLUMNS = {
    "volume": r"^vol(?:ume)?$", "pct": r"^(?:vol\s*)?\(?%\)?$|^fill", "weight": r"^weight$|^mass$|^wt$",
    "lcg": r"^lcg$", "vcg": r"^vcg$|^kg$", "tcg": r"^tcg$", "fs": r"^fs[mi]?$|^free\s*surf", "density": r"^dens", "capacity": r"^cap",
}
KINDS = [(r"ballast|^wb", "Ballast"), (r"fuel|hfo|mdo|mgo|diesel|gasoil", "Fuel"), (r"fresh|^fw|drink", "Fresh water"), (r"cargo\s*hold|^(?:no\.?\s*)?\d*\s*hold", "Hold")]


def kind_of(name: str) -> str:
    return next((k for pattern, k in KINDS if re.search(pattern, name, re.IGNORECASE)), "Other")


def tables(pages: list) -> list:
    """Every table whose heading names at least four known columns: its rows as {name, column: value}, each value
    put under the heading it sits nearest. "Total: X" rows end a group, and name the kind of the rows before them."""
    found = []
    for p, text in enumerate(pages):
        lines = text.splitlines()
        i = 0
        while i < len(lines):
            heads = []
            for start, end, word in cells(lines[i]):
                for w in re.finditer(r"\S+(?: \(%\))?", word):  # (a cell can hold several headings one space apart)
                    key = next((k for k, pat in COLUMNS.items() if re.search(pat, w.group().strip(), re.IGNORECASE)), None)
                    if key:
                        heads.append((key, start + w.start() + len(w.group()) / 2))
            if len({k for k, _ in heads}) < 4:
                i += 1
                continue
            rows, group, blank = [], [], 0
            i += 1
            while i < len(lines) and blank < 3:
                line = lines[i]
                nums = [(m.start() + len(m.group()) / 2, number(m.group())) for m in re.finditer(r"(?<![\w.])[-+]?\d[\d,]*(?:\.\d+)?(?![\w])", line)]
                name_cell = cells(line)[0][2] if line.strip() else ""
                if not line.strip():
                    blank += 1
                    i += 1
                    continue
                if len(nums) < 2 or not re.search(r"[A-Za-z]", name_cell):
                    if not re.search(r"\d", line) and len(cells(line)) <= 2:
                        break  # (a heading of what follows)
                    i += 1
                    continue
                blank = 0
                # the name: the first cell, less any number it ends with that's really the first value
                name = name_cell
                row = {"name": name, "page": p + 1}
                taken = set()
                for x, value in nums:
                    if x < cells(line)[0][1] + 0.5 * (x > cells(line)[0][1]):
                        continue
                    key = min(heads, key=lambda h: abs(h[1] - x))[0]
                    if key not in taken:
                        row[key] = value
                        taken.add(key)
                total = re.match(r"^total\s*:?\s*(.*)$", name, re.IGNORECASE)
                if total:
                    for r in group:
                        r["kind"] = kind_of(total.group(1)) if kind_of(total.group(1)) != "Other" else kind_of(r["name"])
                    group = []
                else:
                    rows.append(row)
                    group.append(row)
                i += 1
            for r in group:
                r["kind"] = kind_of(r["name"])
            found.append({"columns": [k for k, _ in heads], "rows": rows})
    return found


# a weights table's rows that sum others up, not weights of their own
SUMMARY = re.compile(r"^(?:tanks|dead\s*w(?:eigh)?t\.?(?:\s*reserve)?|displacement|light\s*ship|total.*|holds)$", re.IGNORECASE)


def read_particulars(pages: list) -> dict:
    """LBP, LOA, breadth and depth wherever a document prints them, each with where: {particulars, source}."""
    labelled = [(p + 1, line.strip(), label, value) for p, text in enumerate(pages) for line in text.splitlines() for label, value in pairs(line)]
    found, source = {}, {}
    for key, (patterns, (low, high)) in PARTICULARS.items():
        for pattern in patterns:
            hit = next(((p, line, v) for p, line, label, v in labelled if re.search(pattern, label, re.IGNORECASE) and low <= v <= high), None)
            if hit:
                found[key], source[key] = hit[2], f"p. {hit[0]}: {re.sub(r'\s{2,}', '  ', hit[1])[:120]}"
                break
    return {"particulars": found, "source": source}


def read_report(pages: list) -> dict:
    """What a stability report prints: its figures, each with where it was found; its tanks (name, kind, volume and
    weight now, centres, and capacity where the filling tells it); and its other weights (constants, cargo by kind,
    hatch covers...). What isn't found is left out, for typing in."""
    labelled = [(p + 1, line.strip(), label, value) for p, text in enumerate(pages) for line in text.splitlines() for label, value in pairs(line)]
    figures, source = {}, {}
    for key, patterns in FIGURES.items():
        for pattern in patterns:
            hit = next(((p, line, v) for p, line, label, v in labelled if re.search(pattern, label, re.IGNORECASE)), None)
            if hit:
                figures[key], source[key] = hit[2], f"p. {hit[0]}: {re.sub(r'\s{2,}', '  ', hit[1])[:120]}"
                break
    if "trim" in figures and re.search(r"head|fwd|forward", source["trim"], re.IGNORECASE) and figures["trim"] > 0:
        figures["trim"] = -figures["trim"]  # (+ by the stern)
    tanks, items, seen = [], [], set()
    for t in tables(pages):
        cols = set(t["columns"])
        for r in t["rows"]:
            if r["name"] in seen:
                continue
            if "volume" in cols or "density" in cols or "fs" in cols and "pct" in cols:
                seen.add(r["name"])
                pct = r.get("pct")
                capacity = r.get("capacity") or (round(r["volume"] * 100 / pct, 1) if r.get("volume") and pct and pct >= 5 else None)
                tanks.append({"name": r["name"], "kind": r.get("kind", "Other"), "volume": r.get("volume"), "weight": r.get("weight"),
                              "capacity": capacity, **{k: r.get(k) for k in ("lcg", "tcg", "vcg")}})
            elif "weight" in cols and r.get("weight") and not SUMMARY.match(r["name"]) and r["name"].lower().rstrip("s") not in seen:
                seen.add(r["name"].lower().rstrip("s"))
                items.append({"name": r["name"], **{k: r.get(k) for k in ("weight", "lcg", "tcg", "vcg")}})
    name = next((m.group(1).strip() for text in pages[:1] for m in [re.search(r"^\s*([A-Z][A-Z .'-]{3,40}?)\s*(?:\(|$)", text, re.MULTILINE)] if m), None)
    for line in (pages[0].splitlines() if pages else [])[:6]:  # (the ship's name: a line of capitals near the top)
        m = re.match(r"^\s*([A-Z][A-Z .'-]{3,40}[A-Z])\s*(?:\(.*\))?\s*$", line)
        if m:
            name = m.group(1).strip()
            break
    return {"figures": figures, "source": source, "tanks": tanks, "items": items, "name": name}


# --- a stow plan drawn rather than tabled: the units read off where their labels sit on the page

DECKS = r"weather\s*deck|main\s*deck|upper\s*deck|tween\s*deck|2nd\s*deck|lower\s*hold|tank\s*top|hold\s*bottom|hatch\s*cover|forecastle"
UNIT_WEIGHT = re.compile(r"(?:\((\d+(?:\.\d+)?)\)\s*)?(\d+(?:\.\d+)?)\s*(?:MT|T|t)\b")


def text_runs(data: bytes, page_no: int = 0) -> list:
    """A page's text as lines with where they sit: [(x, y, text)], y up the page; runs on one baseline that touch
    joined, those apart by a gap kept apart."""
    from pypdf import PdfReader

    page = PdfReader(io.BytesIO(data)).pages[page_no]
    runs = []

    def seen(text, cm, tm, font, size):
        if text.strip():
            x = tm[4] * cm[0] + tm[5] * cm[2] + cm[4]
            y = tm[4] * cm[1] + tm[5] * cm[3] + cm[5]
            if x or y:  # (text a form draws at the origin has no place on the drawing)
                runs.append((x, y, text.strip()))

    page.extract_text(visitor_text=seen)
    runs.sort(key=lambda r: (-round(r[1], 0), r[0]))
    lines = []
    for x, y, t in runs:
        last = lines[-1] if lines else None
        char = 2.5  # pt a character takes, about, at these drawings' sizes
        if last and abs(last["y"] - y) < 0.8 and -2 * char <= x - last["end"] < 4 * char:
            # (no space inside a number, however its digits were spaced out)
            tight = x - last["end"] < 1.2 or (re.search(r"[\d.,]$", last["text"]) and re.match(r"[\d.,]", t))
            last["text"] += ("" if tight else " ") + t
            last["end"] = x + char * len(t)
        else:
            lines.append({"x": x, "y": y, "end": x + char * len(t), "text": t})
    return lines


def metre_scale(lines: list):
    """The drawing's scale of metres from the AP: a row of evenly stepped numbers along the bottom, fitted as
    x = a + b·m. Of such rows, the one fitted most nearly straight (a row of frame numbers steps unevenly)."""
    import numpy as np

    rows = {}
    for ln in lines:
        if re.fullmatch(r"-?\d+(?:\.\d+)?", ln["text"]):
            rows.setdefault(round(ln["y"]), []).append((ln["x"], float(ln["text"])))
    best = None
    for y, pts in rows.items():
        pts.sort()
        if len(pts) < 8 or any(b[1] <= a[1] for a, b in zip(pts, pts[1:])):
            continue
        xs, ms = np.array([p[0] for p in pts]), np.array([p[1] for p in pts])
        b, a = np.polyfit(ms, xs, 1)
        spread = float(np.std(xs - (a + b * ms)))
        if b > 0 and (best is None or spread < best[2]):
            best = (a, b, spread, ms.max())
    return best


def read_drawing(data: bytes) -> dict:
    """A stow plan drawn over the ship's profile and decks: its units by their labels ("name", "(height) 41.7T"),
    placed lengthways by the drawing's metre scale; on the deck named beside the view they're drawn in; across, about
    the centreline, if a deck view shows several side by side; sized by the plan's key ("4 units of X: L x B x H")."""
    lines = text_runs(data)
    scale = metre_scale(lines)
    if not scale:
        return {"units": [], "note": "No metre scale found on the drawing"}
    a, b, _, _ = scale
    to_m = lambda x: (x - a) / b
    # the decks' names beside their views: short labels, not notes ("5 mt/m2 on Tween Deck") or hatch panels ("#3")
    words = r"^(?:weather|tween|main|upper|2nd|lower|tank\s*top|tanktop|hold|forecastle)(?:\s*deck)?$"
    decks = [ln for ln in lines if re.search(words, ln["text"], re.IGNORECASE)]
    found = []
    for i, ln in enumerate(lines):
        m = UNIT_WEIGHT.search(ln["text"])
        if not m or ln["x"] > a + b * (scale[3] + 30):  # (a key or title block beside the drawing)
            continue
        # the name: the lines just above, over the same place
        above = [o for o in lines[max(0, i - 6) : i] if 0 < o["y"] - ln["y"] < 13 and o["x"] < ln["end"] and o["end"] > ln["x"] and not UNIT_WEIGHT.search(o["text"])]
        name = " ".join(o["text"] for o in sorted(above, key=lambda o: -o["y"])) or ln["text"][: m.start()].strip() or "Cargo"
        x_mid = (min([ln["x"]] + [o["x"] for o in above]) + max([ln["end"]] + [o["end"] for o in above])) / 2
        found.append({"name": name, "weight": float(m.group(2)), "height": float(m.group(1)) if m.group(1) else None,
                      "x": x_mid, "y": ln["y"]})
    # each kind of unit is drawn in several views (profile, then the deck it's on from above): kept from the view
    # that shows the most of them, as that's the one they're all seen in
    units = []
    for key in sorted({(f["weight"], f["height"] or 0) for f in found}):
        same = sorted((f for f in found if (f["weight"], f["height"] or 0) == key), key=lambda f: -f["y"])
        name = max((f["name"] for f in same), key=len)
        groups, group = [], [same[0]]
        for f in same[1:]:
            if group[-1]["y"] - f["y"] < 25:
                group.append(f)
            else:
                groups.append(group)
                group = [f]
        groups.append(group)
        view = max(groups, key=len)
        mid_y = sum(f["y"] for f in view) / len(view)
        deck = min(decks, key=lambda d: abs(d["y"] - mid_y))["text"] if decks else None
        for f in view:
            units.append({"name": name, "weight": key[0], "height": f["height"], "lcg": round(to_m(f["x"]), 2),
                          # (looking down with the bow to the right, starboard is down the page)
                          "tcg": round((mid_y - f["y"]) / b, 2) if len(view) > 1 else 0.0, "deck": deck})
    # the plan's key, row by row: "4 Units of Bridge Handler" over "8.63 x 3.66 x 3.18 m / 41.7 T", matched to the
    # units drawn by weight (or by how many); a kind in the key and not drawn comes in unplaced, to be put in place
    rows = {}
    for ln in lines:
        rows.setdefault(round(ln["y"]), []).append(ln)
    rows = sorted(((y, " ".join(o["text"] for o in sorted(r, key=lambda o: o["x"])), min(o["x"] for o in r)) for y, r in rows.items()), key=lambda r: -r[0])
    for i, (y, text, x) in enumerate(rows):
        k = re.search(r"(\d+)\s*units?\s*of\s*(.+)", text, re.IGNORECASE)
        if not k:
            continue
        below = next((t for yy, t, xx in rows[i + 1 :] if 0 < y - yy < 25 and re.search(r"\d\s*x\s*\d", t)), "")
        dims = re.search(r"(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)(?:\s*x\s*(\d+(?:\.\d+)?))?", below)
        w = re.search(r"/\s*(\d+(?:\.\d+)?)\s*(?:MT|T)\b", below)
        count, what = int(k.group(1)), k.group(2).strip(" -")
        drawn = [u for u in units if (w and abs(u["weight"] - float(w.group(1))) < 0.05) or (not w and sum(1 for v in units if v["name"] == u["name"]) == count)]
        size = [float(dims.group(1)), float(dims.group(2)), float(dims.group(3)) if dims.group(3) else None] if dims else None
        for u in drawn:
            u["key"] = what
            if size:
                u["size"] = [size[0], size[1], size[2] or u["height"] or 2.5]
        if not drawn and w:
            for n in range(count):
                units.append({"name": what, "weight": float(w.group(1)), "height": size[2] if size else None, "lcg": None, "tcg": None,
                              "deck": None, "size": [size[0], size[1], size[2] or 2.5] if size else None, "unplaced": True})
    for u in units:
        u.update({k: float(u[k]) for k in ("lcg", "tcg") if u.get(k) is not None})
    text = " ".join(ln["text"] for ln in lines)
    particulars = {k: number(m.group(1)) for k, pat in (("loa", r"\bLOA\s*:?\s*([\d.,]+)"), ("breadth", r"\bBEAM\s*:?\s*([\d.,]+)"),
                                                         ("lbp", r"\bL\.?B\.?P\.?\s*:?\s*([\d.,]+)"), ("depth", r"\bDEPTH\s*:?\s*([\d.,]+)"))
                   for m in [re.search(pat, text)] if m}
    return {"units": units, "decks": sorted({d["text"] for d in decks}), "particulars": particulars,
            "note": "Positions taken from the drawing's metre scale; transverse positions estimated about the centreline where units are shown side by side"}


# --- a PDF whose words are drawn as lines (a CAD export): drawn here, then read by OCR

DRAWN_SCALE = 8  # pixels a PDF point: a plan's smallest lettering legible to OCR
DRAWN_TILE = 1600  # px of a square read at a time, overlapping by DRAWN_OVERLAP
DRAWN_OVERLAP = 200


def drawn_strokes(data: bytes):
    """The lines a vector-only PDF draws, as polylines in PDF points, and its page size. Read straight off its content
    streams (a CAD export's cross-reference table is often wrong): moves, lines, curves (as short lines), rectangles,
    with the transforms they're drawn under."""
    import zlib

    import numpy as np

    box = re.search(rb"/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]", data)
    size = (float(box.group(3)), float(box.group(4))) if box else (842.0, 595.0)
    streams = []
    for m in re.finditer(rb"stream\r?\n", data):
        end = data.find(b"endstream", m.end())
        try:
            streams.append(zlib.decompressobj().decompress(data[m.end() : end]))
        except zlib.error:
            continue
    lines, path, stack, saved = [], [], [], []
    ctm = np.eye(3)
    at = lambda x, y: tuple((np.array([x, y, 1.0]) @ ctm)[:2])
    for z in streams:
        if not re.search(rb"\b[ml]\s", z[:4000]):
            continue  # (not a drawing's content: fonts, images, metadata)
        for t in re.findall(rb"[-+]?\d*\.?\d+|[A-Za-z*'\"]+", z):
            if t[0:1].isdigit() or t[0:1] in b"-+.":
                stack.append(float(t))
                continue
            if t == b"m" and len(stack) >= 2:
                if len(path) > 1:
                    lines.append(path)
                path = [at(*stack[-2:])]
            elif t == b"l" and len(stack) >= 2 and path:
                path.append(at(*stack[-2:]))
            elif t == b"c" and len(stack) >= 6 and path:
                p0, (a, b, c) = path[-1], (at(*stack[-6:-4]), at(*stack[-4:-2]), at(*stack[-2:]))
                for s in (0.25, 0.5, 0.75, 1.0):
                    u = 1 - s
                    path.append(tuple(u**3 * p0[k] + 3 * u * u * s * a[k] + 3 * u * s * s * b[k] + s**3 * c[k] for k in (0, 1)))
            elif t == b"re" and len(stack) >= 4:
                x, y, w, h = stack[-4:]
                if len(path) > 1:
                    lines.append(path)
                lines.append([at(x, y), at(x + w, y), at(x + w, y + h), at(x, y + h), at(x, y)])
                path = []
            elif t == b"h" and path:
                path.append(path[0])
            elif t in (b"S", b"s", b"f", b"F", b"f*", b"B", b"B*", b"b", b"b*", b"n"):
                if len(path) > 1:
                    lines.append(path)
                path = []
            elif t == b"cm" and len(stack) >= 6:
                a, b, c, d, e, f = stack[-6:]
                ctm = np.array([[a, b, 0], [c, d, 0], [e, f, 1]]) @ ctm
            elif t == b"q":
                saved.append(ctm.copy())
            elif t == b"Q" and saved:
                ctm = saved.pop()
            stack = []
    return lines, size


def drawn_image(data: bytes, scale: float = DRAWN_SCALE):
    """A vector-only PDF's page drawn black on white, at scale pixels a point (y down, as an image)."""
    import cv2
    import numpy as np

    lines, (w, h) = drawn_strokes(data)
    img = np.full((int(h * scale), int(w * scale)), 255, np.uint8)
    pts = [np.array([[x * scale, (h - y) * scale] for x, y in p], np.int32) for p in lines]
    cv2.polylines(img, pts, False, 0, 1, cv2.LINE_8)
    return img, (w, h)


_ocr = None


def _ocr_engine():
    """The OCR engine, made once; None if OCR isn't installed."""
    global _ocr
    if _ocr is None:
        try:
            from rapidocr_onnxruntime import RapidOCR
        except ImportError:
            return None
        threads = max(1, (os.cpu_count() or 2) - 1)  # (a core left for the app's window and the rest)
        _ocr = RapidOCR(intra_op_num_threads=threads, inter_op_num_threads=1)
    return _ocr


def drawn_words(data: bytes) -> list:
    """The words on a vector-only PDF, by OCR of its page drawn here, in tiles: [(x, y, height, text, width)] in PDF
    points, y up the page as PDF has it. Empty if OCR isn't installed."""
    ocr = _ocr_engine()
    if ocr is None:
        return []
    img, (w, h) = drawn_image(data)
    words, step = [], DRAWN_TILE - DRAWN_OVERLAP
    H, W = img.shape
    for top in range(0, max(1, H - DRAWN_OVERLAP), step):
        for left in range(0, max(1, W - DRAWN_OVERLAP), step):
            tile = img[top : top + DRAWN_TILE, left : left + DRAWN_TILE]
            if tile.min() > 200:
                continue  # (blank)
            found, _ = ocr(tile)
            for box, text, conf in found or []:
                xs, ys = [p[0] + left for p in box], [p[1] + top for p in box]
                if float(conf) < 0.5:
                    continue
                words.append((min(xs) / DRAWN_SCALE, h - max(ys) / DRAWN_SCALE, (max(ys) - min(ys)) / DRAWN_SCALE, text.strip(), (max(xs) - min(xs)) / DRAWN_SCALE))
    # (a word read twice where tiles overlap: kept once)
    out = []
    for w_ in sorted(words, key=lambda v: (-v[1], v[0])):
        if not any(o[3] == w_[3] and abs(o[0] - w_[0]) < 3 and abs(o[1] - w_[1]) < 3 for o in out):
            out.append(w_)
    return out


# a capacity plan's decks, by the names drawings give them (OCR's slips forgiven), and how high each is
DECK_NAMES = {"TANKTOP": "Tanktop", "TWEENDECK": "Tween deck", "MAINDECK": "Main deck", "UPPERDECK": "Upper deck",
              "POOPDECK": "Poop deck", "FORECASTLEDECK": "Forecastle deck", "PLATFORMDECK": "Platform deck",
              "WEATHERDECK": "Weather deck", "2NDDECK": "2nd deck", "BRIDGEDECK": "Bridge deck"}


def read_capacity(words: list) -> dict:
    """A capacity plan's deck heights and particulars from its words [(x, y, height, text)], y up the page: each deck's
    name with the "12800 ab. B.L." under it, and of a deck named several times (each section has its own), the one
    lettered largest, as the deck plans are; heights in mm above base read as m."""
    import difflib

    found = {}
    for x, y, h, text, *_ in words:
        key = re.sub(r"[^A-Z0-9]", "", text.upper())
        match = difflib.get_close_matches(key, DECK_NAMES, n=1, cutoff=0.75)
        if not match:
            continue
        below = [(y - y2, t2) for x2, y2, h2, t2, *_ in words if 0 < y - y2 < 2.5 * max(h, 1) and abs(x2 - x) < 12
                 and re.search(r"\d{3,5}(?:/\d+)?\s*[a-z]{0,3}\.?\s*B", t2)]
        if not below:
            continue
        value = float(re.search(r"\d{3,5}", min(below)[1]).group()) / 1000
        name = DECK_NAMES[match[0]]
        if name not in found or h > found[name][1]:
            found[name] = (value, h)
    text = " ".join(w[3] for w in words)
    particulars = {k: number(m.group(1)) for k, pat in (("lbp", r"\b(?:L\.?B\.?P|L\.?P\.?P)\.?\s*[:=]?\s*([\d.,]+)"), ("loa", r"\bL\.?O\.?A\.?\s*[:=]?\s*([\d.,]+)"),
                                                         ("breadth", r"\b(?:BREADTH|BEAM|B\s*mld)\.?\s*[:=]?\s*([\d.,]+)"), ("depth", r"\bDEPTH\.?\s*[:=]?\s*([\d.,]+)"))
                   for m in [re.search(pat, text, re.IGNORECASE)] if m}
    return {"decks": {k: v for k, (v, _) in sorted(found.items(), key=lambda kv: kv[1][0])}, "particulars": particulars}


def pdf_pages(data: bytes, most: int = 400) -> list:
    """A PDF's pages as text, laid out as printed (tables keep their columns). Scanned pages come back empty."""
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    out = []
    for page in reader.pages[:most]:
        try:
            out.append(page.extract_text(extraction_mode="layout") or "")
        except Exception:  # (a page pypdf can't lay out: its plain text, else nothing)
            try:
                out.append(page.extract_text() or "")
            except Exception:
                out.append("")
    return out


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60] or "vessel"


def vessels() -> list:
    STORE.mkdir(parents=True, exist_ok=True)
    out = []
    for path in sorted(STORE.glob("*.json")):
        try:
            v = json.loads(path.read_text(encoding="utf-8"))
            out.append({"id": path.stem, "name": v.get("name", path.stem)})
        except (OSError, ValueError):
            continue
    return out


def load(vessel_id: str) -> dict:
    v = json.loads((STORE / f"{slug(vessel_id)}.json").read_text(encoding="utf-8"))
    return {**migrated(v), "id": slug(vessel_id)}


def migrated(v: dict) -> dict:
    """A vessel kept before the ship and her conditions were apart: her one report and stow plan as her first
    condition."""
    if "conditions" in v:
        return v
    v = dict(v)
    report, stow, docs = v.pop("report", None), v.pop("stow", None), dict(v.get("documents") or {})
    v.pop("compartments", None)
    v["documents"] = {k: n for k, n in docs.items() if k in SHIP_DOCS}
    v["conditions"] = []
    if report or stow:
        name = (docs.get("report") or "Condition 1").rsplit(".", 1)[0]
        v["conditions"] = [{"id": "c1", "name": name, "report": report or {}, "stow": stow or [],
                            "documents": {k: n for k, n in docs.items() if k in CONDITION_DOCS}}]
        v["current"] = "c1"
    return v


def current(v: dict) -> dict:
    """Her condition shown and sailed with: the one marked current, else the latest."""
    conds = v.get("conditions") or []
    return next((c for c in conds if c.get("id") == v.get("current")), conds[-1] if conds else {})


def _num(v):
    return None if v in (None, "") else float(v)


def _mesh(m: dict) -> dict | None:
    """A triangle mesh kept as numbers only: {points: [x, y, z, ...], triangles: [i, j, k, ...]}."""
    pts, tris = m.get("points") or [], m.get("triangles") or []
    if not pts or not tris or len(pts) % 3 or len(tris) % 3:
        return None
    n = len(pts) // 3
    return {"points": [round(float(c), 3) for c in pts], "triangles": [int(i) for i in tris if 0 <= int(i) < n]}


SHIP_DOCS = ("capacity", "ga")  # her own documents: the ship as built
CONDITION_DOCS = ("report", "stow")  # a voyage's: the condition she's loaded to


def _report(r: dict) -> dict:
    return {"figures": {k: float(x) for k, x in (r.get("figures") or {}).items() if k in FIGURES and x not in (None, "")},
            "source": {k: str(s)[:200] for k, s in (r.get("source") or {}).items() if k in FIGURES},
            "items": [{"name": str(c.get("name") or "")[:80], **{k: _num(c.get(k)) for k in ("weight", "lcg", "tcg", "vcg")}}
                      for c in (r.get("items") or [])[:200]]}


def _stow(units: list) -> list:
    return [{"name": str(c.get("name") or "")[:80], **{k: _num(c.get(k)) for k in ("weight", "lcg", "tcg", "vcg", "height")},
             **({"deck": str(c["deck"])[:40]} if c.get("deck") else {}),
             **({"size": [float(s) for s in c["size"]]} if c.get("size") else {})} for c in (units or [])[:5000]]


def save(v: dict) -> str:
    """Kept as given, its numbers checked as numbers: raises ValueError on anything else. The ship (her particulars,
    decks, hull, from her capacity plan and GA) apart from her loading conditions (each a stability report's figures
    and a stow plan's units), one of them current."""
    v = migrated(v)
    name = str(v.get("name") or "").strip()
    if not name:
        raise ValueError("Vessel name required")
    clean = {
        "name": name[:120],
        "principal": {k: _num((v.get("principal") or {}).get(k)) for k in ("lbp", "loa", "breadth", "depth")},
        "decks": {str(k)[:40]: float(h) for k, h in (v.get("decks") or {}).items() if h not in (None, "")},
        "documents": {k: str(n)[:200] for k, n in (v.get("documents") or {}).items() if k in SHIP_DOCS},
        "hull": _mesh(v.get("hull") or {}),
        "conditions": [{"id": re.sub(r"[^a-z0-9-]", "", str(c.get("id") or f"c{i + 1}").lower())[:20] or f"c{i + 1}",
                        "name": str(c.get("name") or f"Condition {i + 1}")[:120], "report": _report(c.get("report") or {}),
                        "stow": _stow(c.get("stow")), "saved": str(c.get("saved") or "")[:30],
                        "documents": {k: str(n)[:200] for k, n in (c.get("documents") or {}).items() if k in CONDITION_DOCS}}
                       for i, c in enumerate((v.get("conditions") or [])[:200])],
    }
    ids = [c["id"] for c in clean["conditions"]]
    clean["current"] = v.get("current") if v.get("current") in ids else (ids[-1] if ids else None)
    if not clean["principal"]["lbp"] or not clean["principal"]["breadth"]:
        raise ValueError("LBP and breadth required: enter them if the documents do not state them (a drawn capacity plan shows the LBP)")
    STORE.mkdir(parents=True, exist_ok=True)
    vid = slug(name)
    (STORE / f"{vid}.json").write_text(json.dumps(clean), encoding="utf-8")
    return vid


def delete(vessel_id: str) -> None:
    (STORE / f"{slug(vessel_id)}.json").unlink(missing_ok=True)


if __name__ == "__main__":
    report = """LOADING CONDITION 5  Departure
  Displacement          31,812.0 t      Deadweight   19,078.2 t
  Draft at A.P.          10.07 m        Draft at F.P.   8.37 m     Draft Mean 9.22 m
  Trim 1.70 m by stern   List 0.0 deg
  KG solid 12.41 m   KG corrected 12.98 m   KMt 13.57 m
  GM corrected 0.59 m   GM solid 1.16 m
  Rolling period 27.3 s"""
    r = read_report(["Particulars: LBP 183.69 m  Breadth 28.65 m  Depth 20.42 m", report])
    f = r["figures"]
    assert f["displacement"] == 31812.0 and f["deadweight"] == 19078.2, f
    assert (f["draught_aft"], f["draught_fwd"], f["draught_mid"]) == (10.07, 8.37, 9.22), f
    assert f["gm"] == 0.59 and f["kg"] == 12.98 and f["km"] == 13.57, f  # (the corrected ones, not solid)
    assert f["roll_period"] == 27.3, f
    pp = read_particulars(["Particulars: LBP 183.69 m  Breadth 28.65 m  Depth 20.42 m", "Length b.p.   140.00 m   Length over all  153.80 m"])["particulars"]
    assert pp == {"lbp": 183.69, "loa": 153.8, "breadth": 28.65, "depth": 20.42}, pp
    assert read_particulars(["Depth contours 5 10 20", "Beam sea 3"])["particulars"] == {}
    assert r["source"]["gm"].startswith("p. 2"), r["source"]
    # a MACS3-style printout: values far from their labels, two pairs a line, a tank table over a units line
    tank_page = [
        "SHIP NAME (07X)", "Tanks",
        "Name" + " " * 30 + "Volume   Vol (%)    Weight      Lcg      Vcg      Tcg     Fs   Density",
        " " * 34 + "m3                 tons   m.fr.AP   m.a.BL  m.fr.CL.    m*t     t/m3",
        "WB-105-DB.P" + " " * 23 + "132.0       100     135.3   104.71     1.10    -6.27      0   1.0250",
        "500-CW-DRAIN.S" + " " * 20 + "  5.0        50       5.0    25.55     0.20     1.96      0   1.0000",
        "Total: WATER BALLAST" + " " * 14 + "137.0        56     140.3    76.18     3.10     0.58   1064   1.0250",
    ]
    result_page = [
        "GM' (corrected)" + " " * 80 + "2.842        1.570    m",
        "Period of rolling" + " " * 60 + "10.87     . sec",
        "Displacement      14106.2   tons    Transverse metacentre ab. baseline KM     10.82   m",
        "Total trim over perpendiculars     1.10m     List due transverse moment     -0.4   degr.",
        "Trim by stern 0.4 degree (1.10 m )",
        "Vertical centre of gravity KG (solid)   7.77m",
        "Vertical centre of gravity corr.   7.98m",
    ]
    macs = ["\n".join(tank_page), "\n".join(result_page)]
    m3 = read_report(macs)
    f = m3["figures"]
    assert (f["gm"], f["roll_period"], f["km"], f["trim"], f["list"], f["kg"]) == (2.842, 10.87, 10.82, 1.1, -0.4, 7.98), f
    assert [t["name"] for t in m3["tanks"]] == ["WB-105-DB.P", "500-CW-DRAIN.S"], m3["tanks"]
    assert m3["tanks"][0]["capacity"] == 132.0 and m3["tanks"][0]["kind"] == "Ballast" and m3["tanks"][1]["tcg"] == 1.96, m3["tanks"]
    assert m3["name"] == "SHIP NAME", m3["name"]
    assert number("9,22") == 9.22 and number("1,234") == 1234 and number("1,234.5") == 1234.5
    print("ok")
