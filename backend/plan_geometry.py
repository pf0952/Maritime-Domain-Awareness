"""A ship's hull, read off her capacity plan's drawing: the frame sections (each "FRAME n", drawn about its centreline),
placed along her by the profile's frame scale, the heights taken from the deck labels ("MAINDECK 12800 ab. B.L.")
beside each row of views. Each section's outline is the area its shell line encloses, filled in (leader lines and
lettering left out); between sections the hull is interpolated, and closed off by the profile's keel and ends.

Works on the page drawn by vessel_docs.drawn_image and the words vessel_docs.drawn_words read off it, both in PDF
points (y up the page). Gives the hull as half-breadths at heights for stations along her, and as a triangle mesh in
the app's frame: x m from the AP (+ forward), y m off the centreline (+ starboard), z m above the baseline."""
import re

import numpy as np

import vessel_docs

SCALE = 8  # px a PDF point, for the outlines
Z_STEP = 0.25  # m between the heights a section's half-breadth is read at
TITLE_HEIGHT = 2.95  # pt: a section's title is lettered at least this tall (smaller "FRAME n" are notes inside one)


# --- the drawing without its words


class Lines:
    """The plan's strokes, and its words' boxes: a part of the page drawn on its own, with the strokes that letter
    a word or lead from its label left out (they close off false areas against the shell)."""

    def __init__(self, data: bytes, words: list):
        self.lines, self.size = vessel_docs.drawn_strokes(data)
        self.boxes = []
        for x, y, h, text, *rest in words:
            width = rest[0] if rest else len(text) * h * 0.6
            self.boxes.append((x - 1.0, y - 1.0, x + width + 1.0, y + h + 1.0))
        self.boxes = np.array(self.boxes) if self.boxes else np.zeros((0, 4))
        arr = [np.array(p) for p in self.lines]
        self.bbox = np.array([(a[:, 0].min(), a[:, 1].min(), a[:, 0].max(), a[:, 1].max()) for a in arr])
        self.kept = np.array([not self._lettering(a) for a in arr])
        self.arr = arr

    def _inside(self, pt) -> bool:
        b = self.boxes
        return bool(((b[:, 0] <= pt[0]) & (pt[0] <= b[:, 2]) & (b[:, 1] <= pt[1]) & (pt[1] <= b[:, 3])).any()) if len(b) else False

    def _lettering(self, a) -> bool:
        ends = [self._inside(a[0]), self._inside(a[-1])]
        if all(ends) and (len(a) == 2 or all(self._inside(q) for q in a)):
            return True  # (a glyph or an underline)
        if len(a) == 2 and any(ends) and np.hypot(*(a[1] - a[0])) > 2.0:
            return True  # (a leader from a label)
        return False

    def draw(self, x0, y0, x1, y1, scale=SCALE, lettering=False):
        """The page's lines within a box, black on white, without lettering or leaders unless asked for."""
        import cv2

        img = np.full((int((y1 - y0) * scale), int((x1 - x0) * scale)), 255, np.uint8)
        b = self.bbox
        hit = (self.kept | lettering) & (b[:, 2] >= x0) & (b[:, 0] <= x1) & (b[:, 3] >= y0) & (b[:, 1] <= y1)
        pts = [np.array([[(x - x0) * scale, (y1 - y) * scale] for x, y in self.arr[i]], np.int32) for i in np.nonzero(hit)[0]]
        cv2.polylines(img, pts, False, 0, 1, cv2.LINE_8)
        return img


# --- reading the views


def deck_marks(words: list) -> list:
    """Each deck label with its height: (x, y of its line, z m), from a deck's name over "12800 ab. B.L."."""
    import difflib

    out = []
    for x, y, h, text, *_ in words:
        key = re.sub(r"[^A-Z0-9]", "", text.upper())
        if not difflib.get_close_matches(key, vessel_docs.DECK_NAMES, n=1, cutoff=0.75):
            continue
        below = [(y - y2, t2) for x2, y2, h2, t2, *_ in words if 0 < y - y2 < 2.5 * max(h, 1) and abs(x2 - x) < 12
                 and re.search(r"\d{3,5}(?:/\d+)?\s*[a-z]{0,3}\.?\s*B", t2)]
        if below:
            out.append((x, y - 0.35, float(re.search(r"\d{3,5}", min(below)[1]).group()) / 1000))
    return out


def vertical_scale(marks: list, y_lo: float, y_hi: float, x_lo: float = -1e9, x_hi: float = 1e9):
    """Height from page y within a band of the drawing, fitted to the deck labels in it: (y0, k), y = y0 + k·z."""
    pts = [(y, z) for x, y, z in marks if y_lo <= y <= y_hi and x_lo <= x <= x_hi]
    if len({round(z, 2) for _, z in pts}) < 2:
        return None
    ys, zs = np.array([p[0] for p in pts]), np.array([p[1] for p in pts])
    k, y0 = np.polyfit(zs, ys, 1)
    # (labels misread or placed off their line: the worst dropped while the fit is poor)
    while len(ys) > 3 and np.abs(ys - (y0 + k * zs)).max() > 1.0:
        worst = np.abs(ys - (y0 + k * zs)).argmax()
        ys, zs = np.delete(ys, worst), np.delete(zs, worst)
        k, y0 = np.polyfit(zs, ys, 1)
    return (float(y0), float(k)) if 1.0 < k < 6.0 else None


def section_titles(words: list) -> list:
    """The sections' titles: (frames, x of its middle, y), frames one or two ("FRAME 60 / 130": the same section
    from one to the other)."""
    out = []
    for x, y, h, text, *rest in words:
        width = rest[0] if rest else 4 * h
        t = text.upper().replace("RAM", "RAM")
        m = re.search(r"F\s*R\s*A\s*M\s*E\s*(-?\d+(?:[.,]\d+)?)(?:\s*/\s*(\d+))?\s*$", t)
        if not m or h < TITLE_HEIGHT or "(" in t or "-" in t[m.end(1):]:
            continue
        frames = [float(m.group(1).replace(",", "."))] + ([float(m.group(2))] if m.group(2) else [])
        share = m.start() / max(len(t), 1)  # (a title read run together with a label before it)
        mid = x + width * (share + (1 - share) / 2)
        out.append((frames, mid, y, width, h))
    # (a section's title is one of a row of them; a lone "FRAME n" is a note on a section or a detail)
    return [t[:3] + t[3:] for t in out if sum(1 for o in out if o is not t and abs(o[2] - t[2]) < 2.5) >= 1]


def reread_titles(lines: "Lines", titles: list) -> list:
    """Each title's frame numbers read again from the title alone at high resolution (a small 6 is read as an 8)."""
    ocr = vessel_docs._ocr_engine()
    out = []
    for frames, mid, y, width, h in titles:
        img = lines.draw(mid - width / 2 - 2, y - 1.5, mid + width / 2 + 2, y + h + 1.5, scale=24, lettering=True)
        res, _ = ocr(img) if ocr else (None, None)
        text = " ".join(t for _, t, c in (res or []) if float(c) > 0.5).upper()
        m = re.search(r"F\s*R\s*A\s*M\s*E\s*(-?\d+(?:[.,]\d+)?)(?:\s*/\s*(\d+))?", text)
        if m:
            frames = [float(m.group(1).replace(",", "."))] + ([float(m.group(2))] if m.group(2) else [])
        out.append((frames, mid, y))
    return out


def frame_scale(img, words: list, size):
    """Frame number to page x along the profile, from its frame scale: the row of frame numbers under the keel,
    read again at high resolution, kept where they follow on evenly. A function of frame number."""
    from rapidocr_onnxruntime import RapidOCR

    w, h = size
    rows = {}
    for x, y, hh, text, *_ in words:
        if re.fullmatch(r"-?\d{1,3}", text) and x < w * 0.55:
            rows.setdefault(round(y), []).append(x)
    band = max(rows.items(), key=lambda r: len(r[1]))[0] if rows else None
    if band is None:
        return None
    hi = 20  # px a point
    import cv2

    y0, y1 = band - 3, band + 6
    lines, _ = vessel_docs.drawn_strokes(_data_of[0])
    strip = np.full((int((y1 - y0) * hi), int(w * 0.55 * hi)), 255, np.uint8)
    pts = [np.array([[x * hi, (y1 - y) * hi] for x, y in p], np.int32) for p in lines
           if any(y0 - 1 < y < y1 + 1 and x < w * 0.55 for x, y in p)]
    cv2.polylines(strip, pts, False, 0, 1, cv2.LINE_8)
    ocr = vessel_docs._ocr_engine()
    found = []
    for left in range(0, strip.shape[1], 1400):
        res, _ = ocr(strip[:, left : left + 1500])
        for box, t, c in res or []:
            if re.fullmatch(r"-?\d{1,3}", t) and float(c) > 0.6:
                found.append(((left + (box[0][0] + box[1][0]) / 2) / hi, int(t)))
    found.sort()
    # the longest run that follows on: frames rising, about as many points a frame as their neighbours
    best = []
    for i in range(len(found)):
        run = [found[i]]
        for x, f in found[i + 1 :]:
            px, pf = run[-1]
            if f > pf and 0.8 < (x - px) / (f - pf) < 2.6:
                run.append((x, f))
        if len(run) > len(best):
            best = run
    if len(best) < 6:
        return None
    fx, ff = np.array([b[0] for b in best]), np.array([b[1] for b in best], float)

    def x_of(frame):
        if frame <= ff[0]:
            return float(fx[0] + (frame - ff[0]) * (fx[1] - fx[0]) / (ff[1] - ff[0]))
        if frame >= ff[-1]:
            return float(fx[-1] + (frame - ff[-1]) * (fx[-1] - fx[-2]) / (ff[-1] - ff[-2]))
        return float(np.interp(frame, ff, fx))

    return x_of, (float(band), best)


_data_of = [None]


def solid(ink, opening: int):
    """What a view's outline encloses: everything the outside can't reach, less the thin lines and lettering."""
    import cv2

    k3 = np.ones((3, 3), np.uint8)
    lines = cv2.dilate(ink.astype(np.uint8), k3, iterations=1)
    free = np.pad((lines == 0).astype(np.uint8), 1, constant_values=1)
    mask = np.zeros((free.shape[0] + 2, free.shape[1] + 2), np.uint8)
    cv2.floodFill(free, mask, (0, 0), 2)
    inside = (free[1:-1, 1:-1] != 2).astype(np.uint8)
    inside = cv2.morphologyEx(inside, cv2.MORPH_OPEN, np.ones((opening, opening), np.uint8))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(inside, 8)
    if n < 2:
        return np.zeros_like(inside, bool)
    biggest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    return labels == biggest


def read_section(lines: "Lines", title, scale, highest: float = 99.0):
    """A section's half-breadths at heights: {z: [...], hb: [...], centre} in m, from the area its shell encloses."""
    frames, cx, ty = title
    y0, k = scale
    x0, x1, yb, yt = cx - 31, cx + 31, max(ty - 57, y0 - 0.5 * k), ty - 1.2
    sub = lines.draw(x0, yb, x1, yt) < 128
    body = solid(sub, max(3, int(0.7 * SCALE)))
    rows = np.where(body.any(axis=1))[0]
    if not len(rows):
        return None
    # the centreline: the long vertical line near the middle of the view
    ink = sub.sum(axis=0)
    mid_c = int(round((cx - x0) * SCALE))
    near = range(max(mid_c - 3 * SCALE, 0), min(mid_c + 3 * SCALE, sub.shape[1]))
    centre = max(near, key=lambda c: ink[c]) if len(near) else mid_c
    zs, hbs = [], []
    for r in rows:
        cols = np.where(body[r])[0]
        left, right = (centre - cols[0]) / SCALE / k, (cols[-1] - centre) / SCALE / k
        both = left > 0.2 and right > 0.2
        zs.append((yt - r / SCALE - y0) / k)
        hbs.append(min(left, right) if both else max(left, right, 0.0))
    order = np.argsort(zs)
    zs, hbs = np.array(zs)[order], np.array(hbs)[order]
    zs, hbs = zs[zs >= -0.1], hbs[zs >= -0.1]
    if len(zs) < 3:
        return None
    # the shell ends at its deck: above, narrower things stand on it (coamings, casings, houses); looked for only in
    # the upper half, and only where it stays narrower
    top = zs[-1]
    widest = np.maximum.accumulate(hbs)
    half = zs[0] + (zs[-1] - zs[0]) / 2
    for i in range(len(zs)):
        if zs[i] > half and hbs[i] < 0.8 * widest[i] and (hbs[i:] < 0.85 * widest[i]).all():
            top = zs[i - 1]
            break
    top = min(top, highest)  # (no higher than her highest hull deck: a house on it isn't hull)
    keep = zs <= top + 1e-6
    grid = np.arange(np.ceil(zs[keep][0] / Z_STEP) * Z_STEP, top + 1e-6, Z_STEP)
    if len(grid) < 3:
        return None
    return {"frames": frames, "z": grid.round(3).tolist(), "hb": np.interp(grid, zs[keep], hbs[keep]).round(3).tolist(),
            "bottom": float(zs[keep][0]), "top": float(top), "box": (x0, yb, x1, yt), "centre": x0 + centre / SCALE}


def read_profile(lines: "Lines", band, scale):
    """The profile's outline: for each page x, the lowest and highest height its outline encloses, below the decks."""
    w, h = lines.size
    y0, k = scale
    yb, yt = max(band - 1.0, y0 - 0.3 * k), band + 80
    sub = lines.draw(0, yb, w * 0.55, yt) < 128
    body = solid(sub, max(3, int(0.7 * SCALE)))
    cols = np.where(body.any(axis=0))[0]
    out = {}
    for c in cols:
        r = np.where(body[:, c])[0]
        out[c / SCALE] = ((yt - r[-1] / SCALE - y0) / k, (yt - r[0] / SCALE - y0) / k)
    return out


# --- the hull


HULL_DECKS = ("Poop deck", "Forecastle deck", "Main deck", "Upper deck", "Weather deck")


def hull_from_plan(data: bytes, words: list) -> dict | None:
    """Her hull from a drawn capacity plan: sections placed at their frames, lofted between, closed by the profile.
    {sections: [{x, z, hb}], mesh: {points, triangles}, length, breadth} or None where the drawing won't give it."""
    _data_of[0] = data
    lines = Lines(data, words)
    size = lines.size
    img = None
    marks = deck_marks(words)
    decks = vessel_docs.read_capacity(words)["decks"]
    highest = max([decks[d] for d in HULL_DECKS if d in decks], default=99.0) + 0.3
    scale = frame_scale(img, words, size)
    if not scale:
        return None
    x_of, (band, _) = scale
    # metres a page point along her: the same as up her, the drawing's scale, from the profile's deck labels
    prof_scale = vertical_scale(marks, band - 5, band + 80, x_hi=size[0] * 0.55)
    if not prof_scale:
        return None
    k = prof_scale[1]
    ap = x_of(0)
    sections = []
    titles = reread_titles(lines, section_titles(words))
    across = (min(t[1] for t in titles) - 45, max(t[1] for t in titles) + 45) if titles else (0, 0)
    for title in titles:
        s = vertical_scale(marks, title[2] - 58, title[2], *across)
        if not s:
            continue
        got = read_section(lines, title, s, highest)
        if got:
            for f in got["frames"]:
                sections.append({**got, "frame": f, "x": round((x_of(f) - ap) / k, 2)})
    if len(sections) < 3:
        return None
    sections.sort(key=lambda s: s["x"])
    profile = read_profile(lines, band, prof_scale)
    px = np.array(sorted(profile))
    keel = np.array([profile[p][0] for p in px])
    deck = np.array([profile[p][1] for p in px])
    xs_m = (px - ap) / k
    for s in sections:
        s.pop("box", None)
    return {"sections": sections, "profile": {"x": xs_m.round(2).tolist(), "bottom": keel.round(3).tolist()},
            "mesh": loft(sections, xs_m, keel, deck), "aft": float(xs_m[0]), "fore": float(xs_m[-1])}


FAIR_Z = 0.25  # m between the heights the hull is faired at
FAIR_X = 0.5  # m between its stations
SPIKE = 0.5  # m: a section standing out from both neighbours by more than this, at a height, is put in line with them
SMOOTH_PASSES = 2  # of a light smoothing along her, over the faired surface (not up it: the bilge stays a corner)
FLAT = 0.985  # a breadth this close to the widest is the flat of side (or of the parallel middle body), squared off
GAP = 4.0  # m: a gap in the hull along her this short, between hull either side, filled in
FAIRNESS = 1500.0  # how much a waterline's smoothness counts against passing through every section (Whittaker λ)
MESH_X = 1.0  # m between the stations of the mesh kept (faired at FAIR_X)


def _runs(a: np.ndarray, n: int, how) -> np.ndarray:
    """A sliding window's median or mean, the ends padded with their own values."""
    if len(a) < 3:
        return a
    n = min(n, len(a) | 1)
    pad = np.pad(a, n // 2, mode="edge")
    win = np.lib.stride_tricks.sliding_window_view(pad, n)
    return how(win, axis=1)


def pchip(x: np.ndarray, y: np.ndarray, xq: np.ndarray) -> np.ndarray:
    """Monotone cubic interpolation (Fritsch–Carlson): smooth through the points, never overshooting them."""
    if len(x) == 1:
        return np.full_like(xq, y[0], dtype=float)
    h = np.diff(x)
    d = np.diff(y) / h
    m = np.zeros_like(y, dtype=float)
    m[0], m[-1] = d[0], d[-1]
    for k in range(1, len(x) - 1):
        if d[k - 1] * d[k] > 0:
            w1, w2 = 2 * h[k] + h[k - 1], h[k] + 2 * h[k - 1]
            m[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k])
    i = np.clip(np.searchsorted(x, xq) - 1, 0, len(x) - 2)
    t = np.clip((xq - x[i]) / h[i], 0, 1)
    h00, h10, h01, h11 = 2 * t ** 3 - 3 * t ** 2 + 1, t ** 3 - 2 * t ** 2 + t, -2 * t ** 3 + 3 * t ** 2, t ** 3 - t ** 2
    return h00 * y[i] + h10 * h[i] * m[i] + h01 * y[i + 1] + h11 * h[i] * m[i + 1]


def flatten(h: np.ndarray, widest) -> np.ndarray:
    """Breadths near the widest drawn out to it smoothly: those within FLAT of it become it (the flat of side, the
    parallel middle body, one breadth), those a little further off eased towards it, so there's no step where the
    flat meets the curve."""
    w = np.asarray(widest, float)
    start = (2 * FLAT - 1) * w  # (the easing begins as far below FLAT as FLAT is below the widest)
    t = np.clip((h - start) / np.maximum(w - start, 1e-9) * 2, 0, 1)
    ease = t * t * (3 - 2 * t)
    return np.where(h > 0, h + (w - h) * ease * (h >= start), h)


def fair_sections(sections: list, levels: np.ndarray) -> np.ndarray:
    """The sections on a common grid of heights, faired: each smoothed and never narrowing from the keel up to its
    widest (a shell doesn't notch in), then, height by height, any that stands out from both its neighbours put in line
    with them. NaN where a section has no hull."""
    grid = np.full((len(sections), len(levels)), np.nan)
    for i, s in enumerate(sections):
        z, hb = np.array(s["z"]), np.array(s["hb"])
        hb = _runs(_runs(hb, 5, np.median), 5, np.mean)
        # never narrowing going up, anywhere: a shell doesn't step in (lines on the drawing meeting the side read as
        # notches; a deck's line or a coaming's, as a narrowing)
        hb = np.maximum.accumulate(hb)
        hb = flatten(hb, hb[-1])  # (the flat of side: one breadth, eased into the bilge)
        # (a section on the baseline: its flat of bottom carried down to it, not tapered to the centreline)
        inside = (levels >= (0.0 if s["bottom"] <= 0.5 else s["bottom"])) & (levels <= s["top"])
        grid[i, inside] = np.interp(levels[inside], z, hb)
    for j in range(len(levels)):
        col = grid[:, j]
        for i in range(1, len(sections) - 1):
            a, v, b = col[i - 1], col[i], col[i + 1]
            if np.isnan(a) or np.isnan(v) or np.isnan(b):
                continue
            if abs(v - (a + b) / 2) > SPIKE and abs(a - b) < abs(v - (a + b) / 2):
                col[i] = (a + b) / 2
    return grid


def smooth_grid(grid: np.ndarray, passes: int, axes=(0,)) -> np.ndarray:
    """A light [1 2 1] smoothing along the hull (or up it too), over the hull only (its edges stay where they are)."""
    k = np.array([1.0, 2.0, 1.0])
    for _ in range(passes):
        for axis in axes:
            on = (grid > 0).astype(float)
            pad = lambda a: np.pad(a, [(1, 1) if ax == axis else (0, 0) for ax in range(2)], mode="edge")
            gs, ws = pad(grid * on), pad(on)
            shift = lambda a, o: np.take(a, np.arange(o, o + grid.shape[axis]), axis=axis)
            num = sum(k[o] * shift(gs, o) for o in range(3))
            den = sum(k[o] * shift(ws, o) for o in range(3))
            grid = np.where(on > 0, num / np.maximum(den, 1e-9), 0.0)
    return grid


def whittaker(n: int, at: np.ndarray, values: np.ndarray, weights: np.ndarray, lam: float) -> np.ndarray:
    """A smooth curve on n even steps, fitted to values at some of them: least squares on the values plus lam times the
    curve's bending (its second differences squared). Close to the sections, but no kink at any one of them."""
    w = np.zeros(n)
    d = np.zeros(n)
    np.add.at(w, at, weights)
    np.add.at(d, at, weights * values)
    D = np.diff(np.eye(n), 2, axis=0)
    return np.linalg.solve(np.diag(w) + lam * D.T @ D + 1e-9 * np.eye(n), d)


def loft(sections: list, xs: np.ndarray, keel: np.ndarray, deck: np.ndarray) -> dict:
    """A closed, faired triangle mesh through the sections. The sections faired (fair_sections); along her, each
    height's half-breadths joined by a smooth curve through the sections (pchip), and past the end sections rounding
    into the stem and stern lines; nothing below the profile's keel line (smoothed) nor beyond her ends; a last light
    smoothing over the whole surface."""
    top = max(s["top"] for s in sections)
    # (closer together low down, where the bilge turns fast: 0.1 m to 2 m, then FAIR_Z)
    levels = np.concatenate([np.arange(0, min(2.0, top), 0.1), np.arange(2.0, top + FAIR_Z, FAIR_Z)])
    stations = np.arange(xs[0], xs[-1] + 1e-6, FAIR_X)
    sx = np.array([s["x"] for s in sections])
    keel = _runs(_runs(keel, 15, np.median), 15, np.mean)
    deck = _runs(deck, 15, np.median)
    faired = fair_sections(sections, levels)
    tops = np.array([s["top"] for s in sections])
    grid = np.zeros((len(stations), len(levels)))
    floor = np.interp(stations, xs, keel)
    for jz, z in enumerate(levels):
        inside = xs[(keel <= z + 0.4) & (deck >= z)]
        if not len(inside):
            continue
        aft, fore = float(inside.min()), float(inside.max())
        have = ~np.isnan(faired[:, jz])
        if not have.any():
            continue
        # where she has hull at this height: within her ends, and below the deck of the section nearest each
        # station (so a poop's or forecastle's end stays a step, midway between the sections either side of it)
        nearest = np.abs(stations[:, None] - sx[None, :]).argmin(axis=1)
        present = (stations >= aft) & (stations <= fore) & (tops[nearest] >= z)
        row = np.zeros(len(stations))
        # each stretch of hull fitted on its own: close to its sections, smooth between them
        edges = np.flatnonzero(np.diff(np.concatenate([[0], present.astype(int), [0]])))
        for start, end in zip(edges[::2], edges[1::2]):
            span = np.arange(start, end)
            inside = have & (sx >= stations[start] - FAIR_X) & (sx <= stations[end - 1] + FAIR_X)
            if len(span) < 4 or not inside.any():
                continue
            px, py = sx[inside], faired[inside, jz]
            at = list(np.clip(np.round((px - stations[start]) / FAIR_X).astype(int), 0, len(span) - 1))
            vals, wts = list(py), [1.0] * len(py)
            # her ends, where they lie well beyond the end sections: the waterline closing to nothing there
            if end - 1 >= np.flatnonzero(stations <= fore)[-1] and fore - px[-1] > 2.0:
                at.append(len(span) - 1); vals.append(0.0); wts.append(1.0)
            if start <= np.flatnonzero(stations >= aft)[0] and px[0] - aft > 2.0:
                at.append(0); vals.append(0.0); wts.append(1.0)
            # (a fitted batten bows out between far-apart sections: never wider than the widest drawn at this height)
            row[span] = np.clip(whittaker(len(span), np.array(at), np.array(vals), np.array(wts), FAIRNESS), 0, py.max())
        row[(stations < aft) | (stations > fore) | (z < floor - 0.4)] = 0.0
        grid[:, jz] = np.maximum(row, 0.0)
    grid = smooth_grid(grid, SMOOTH_PASSES)
    grid = fill_gaps(grid, int(round(GAP / FAIR_X)))
    # up the hull, smoothed where it curves (the bilge, the bow's and stern's sections), not on its flats
    curved = (grid > 0) & (grid < FLAT * grid.max(axis=1, keepdims=True))
    grid = np.where(curved, smooth_grid(grid, 4, axes=(1,)), grid)
    for j in range(grid.shape[1]):  # (the parallel middle body: one breadth along her, eased into the ends)
        if grid[:, j].max() > 0:
            grid[:, j] = flatten(grid[:, j], grid[:, j].max())
    keep_every = max(1, int(round(MESH_X / FAIR_X)))
    stations, grid = stations[::keep_every], grid[::keep_every]
    return closed_mesh(stations, levels, grid)


def fill_gaps(grid: np.ndarray, most: int) -> np.ndarray:
    """No holes in the hull: up each station, any height without breadth between heights with it filled in from
    them; along her, any short stretch without hull between hull either side, likewise."""
    grid = grid.copy()
    for i in range(grid.shape[0]):
        on = np.flatnonzero(grid[i] > 0)
        if len(on) > 1:
            gap = np.arange(on[0], on[-1] + 1)
            grid[i, gap] = np.interp(gap, on, grid[i, on])
    for j in range(grid.shape[1]):
        on = np.flatnonzero(grid[:, j] > 0)
        for a, b in zip(on, on[1:]):
            if 1 < b - a <= most:
                grid[a + 1 : b, j] = np.interp(np.arange(a + 1, b), [a, b], [grid[a, j], grid[b, j]])
    return grid


RING_BOTTOM = 6  # points across the flat of bottom, keel to the turn of the bilge
RING_SIDE = 48  # up the side, bilge to deck edge (spaced evenly along the girth)
RING_DECK = 6  # across the deck, edge to centreline
BREAK = 0.4  # m: a step in deck height this big between stations is a break (poop front, forecastle end): kept square
RING_SMOOTH = 3  # passes of smoothing round each outline
ALONG_SMOOTH = 6  # and along her, station to station (never across a break)


def _resample(pts: np.ndarray, n: int) -> np.ndarray:
    """A polyline as n points spaced evenly along it."""
    seg = np.hypot(*np.diff(pts, axis=0).T)
    s = np.concatenate([[0], np.cumsum(seg)])
    if s[-1] <= 0:
        return np.repeat(pts[:1], n, axis=0)
    t = np.linspace(0, s[-1], n)
    return np.stack([np.interp(t, s, pts[:, 0]), np.interp(t, s, pts[:, 1])], 1)


def station_outline(hb: np.ndarray, levels: np.ndarray):
    """A station's half outline, keel to deck centre, in three parts of fixed point counts: the bottom (centreline out
    to the bilge), the side (up to the deck edge), the deck (in to the centreline). None where it has no hull."""
    on = np.flatnonzero(hb > 0)
    if len(on) < 2:
        return None
    side = np.stack([hb[on[0] : on[-1] + 1], levels[on[0] : on[-1] + 1]], 1)
    zb, zt = side[0, 1], side[-1, 1]
    bottom = np.stack([np.linspace(0, side[0, 0], RING_BOTTOM), np.full(RING_BOTTOM, zb)], 1)
    deck = np.stack([np.linspace(side[-1, 0], 0, RING_DECK), np.full(RING_DECK, zt)], 1)
    return np.concatenate([bottom[:-1], _resample(side, RING_SIDE), deck[1:]])


def closed_mesh(stations: np.ndarray, levels: np.ndarray, grid: np.ndarray) -> dict:
    """A watertight hull lofted through station outlines: each station's outline in fixed parts (bottom, side, deck), so
    a point joins the same point of the next (keel to keel, deck edge to deck edge) and nothing twists or folds; the
    outlines smoothed round themselves and along her, but not across a break in the deck, which stays a square step
    (a bulkhead); the stern's and stem's last outlines capped flat."""
    import mapbox_earcut as earcut

    keep = [i for i in range(len(stations)) if station_outline(grid[i], levels) is not None]
    xs = stations[keep]
    halves = np.array([station_outline(grid[i], levels) for i in keep])  # (stations, points, [y, z])
    h = halves.shape[1]
    n_bottom, n_side = RING_BOTTOM - 1, RING_SIDE
    # round each outline: the side's points smoothed (its ends, the bilge's turn and the deck edge, held)
    for _ in range(RING_SMOOTH):
        s0, s1 = n_bottom + 1, n_bottom + n_side - 1
        halves[:, s0:s1] = (halves[:, s0 - 1 : s1 - 1] + 2 * halves[:, s0:s1] + halves[:, s0 + 1 : s1 + 1]) / 4
    # along her: each point smoothed with its fellows at the stations either side, but not across a break
    decks = halves[:, -1, 1]
    joined = np.abs(np.diff(decks)) < BREAK  # (station i to i + 1)
    for _ in range(ALONG_SMOOTH):
        new = halves.copy()
        for i in range(1, len(xs) - 1):
            if joined[i - 1] and joined[i]:
                new[i] = (halves[i - 1] + 2 * halves[i] + halves[i + 1]) / 4
        halves = new
    halves[:, 0, 0] = 0.0  # (the keel and the deck's middle on the centreline, exactly)
    halves[:, -1, 0] = 0.0
    halves[:, n_bottom + n_side :, 1] = halves[:, -1:, 1]  # (each deck flat across)
    halves[:, :RING_BOTTOM, 1] = halves[:, :1, 1]  # (and the flat of bottom flat)
    # at a break, the next outline repeated 2 cm on: the step comes out a vertical bulkhead, not a slope
    at_x, outlines = [xs[0]], [halves[0]]
    for i in range(1, len(xs)):
        if not joined[i - 1]:
            at_x.append(xs[i - 1] + 0.02)
            outlines.append(halves[i])
        at_x.append(xs[i])
        outlines.append(halves[i])
    xs, halves = np.array(at_x), np.array(outlines)
    # rings: starboard keel to deck centre, then back down the port side
    rings = np.concatenate([halves, halves[:, -2:0:-1] * np.array([-1, 1])], axis=1)
    r = rings.shape[1]
    points = np.concatenate([np.repeat(xs, r)[:, None], rings.reshape(-1, 2)], 1)
    tris = []
    for i in range(len(xs) - 1):
        a, b = i * r, (i + 1) * r
        for k in range(r):
            k2 = (k + 1) % r
            tris += [(a + k, b + k, a + k2), (a + k2, b + k, b + k2)]
    for i, flip in ((0, True), (len(xs) - 1, False)):
        cap = earcut.triangulate_float64(rings[i].astype(float), np.array([r], np.uint32)).tolist()
        for t in range(0, len(cap), 3):
            tri = (i * r + cap[t], i * r + cap[t + 1], i * r + cap[t + 2])
            tris.append(tri[::-1] if flip else tri)
    tris = np.array(tris)
    area = np.linalg.norm(np.cross(points[tris[:, 1]] - points[tris[:, 0]], points[tris[:, 2]] - points[tris[:, 0]]), axis=1)
    tris = tris[area > 1e-6]
    return {"points": [round(float(c), 3) for c in points.ravel()], "triangles": [int(i) for i in tris.ravel()]}


if __name__ == "__main__":
    # a box hull lofted from three sections 20 m wide and 10 m deep, along a flat keel 0 to 100 m
    box = [{"x": float(x), "z": [0.0, 10.0], "hb": [10.0, 10.0], "bottom": 0.0, "top": 10.0} for x in (0, 50, 100)]
    xs = np.linspace(0, 100, 101)
    m = loft(box, xs, np.zeros_like(xs), np.full_like(xs, 10.0))
    p = np.array(m["points"]).reshape(-1, 3)
    assert abs(p[:, 1].max() - 10) < 1e-6 and abs(p[:, 1].min() + 10) < 1e-6, (p[:, 1].min(), p[:, 1].max())
    assert p[:, 0].min() == 0 and p[:, 0].max() == 100 and p[:, 2].max() <= 10.0
    assert len(m["triangles"]) % 3 == 0 and max(m["triangles"]) < len(p)
    # watertight: every edge of the box hull's faces is shared by exactly two of them (points merged where they meet)
    key = {tuple(q): n for n, q in enumerate(np.round(p, 3).tolist())}
    ids = [key[tuple(q)] for q in np.round(p, 3).tolist()]
    edges = {}
    for t in np.array(m["triangles"]).reshape(-1, 3):
        a, b, c = (ids[v] for v in t)
        for e in ((a, b), (b, c), (c, a)):
            edges[tuple(sorted(e))] = edges.get(tuple(sorted(e)), 0) + 1
    assert all(n == 2 for n in edges.values()), sorted(set(edges.values()))
    assert np.isclose(p[:, 2].min(), 0) and (np.abs(p[np.isclose(p[:, 2], 0)][:, 1]) > 9.9).any()  # (a flat bottom)
    # the flats eased in: within FLAT of the widest, the widest; below the easing, untouched; no step between
    eased = flatten(np.linspace(9.0, 10.0, 101), 10.0)
    assert eased[-1] == 10.0 and eased[0] == 9.0 and np.all(np.diff(eased) >= -1e-12) and np.max(np.diff(eased)) < 0.05
    # a fitted waterline: through a step of noise at one section, it stays near the others and bends little
    fit = whittaker(101, np.arange(0, 101, 10), np.array([10.0] * 5 + [9.0] + [10.0] * 5), np.ones(11), FAIRNESS)
    assert abs(fit[0] - 10) < 0.2 and abs(fit[100] - 10) < 0.2 and fit[50] > 9.5, (fit[0], fit[50], fit[100])
    assert abs(pchip(np.array([0.0, 1, 2]), np.array([0.0, 1, 1]), np.array([1.5]))[0] - 1) < 1e-9  # (no overshoot)
    print("ok")
