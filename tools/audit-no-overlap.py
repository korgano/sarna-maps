"""Geometric no-overlap audit for a generated SVG map.

Verifies, on the REAL rendered geometry (not synthetic fixtures):
  1. no border STROKE of faction A runs inside a FILL of faction B (A != B)
  2. no radius DISK (<circle style="stroke: none">) sits inside ANY fill
     (fills must never stack: disk + territory)
  3. reports the distance of the worst remaining case (boundary-following
     strokes are protected by a small epsilon on purpose)

Usage: python tools\audit-no-overlap.py <map.svg>
"""
import re
import sys
import math

EPS = 0.05          # map units; strokes running along a foreign contour are legal
SAMPLES = 16        # samples per bezier segment when flattening

NUM = r'-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?'
CMD = re.compile(r'([MLQCZmlqcz])|(' + NUM + r')')


def tokenize(d):
    out = []
    for m in CMD.finditer(d):
        out.append(m.group(1) if m.group(1) else float(m.group(2)))
    return out


def flatten(d):
    """Returns list of contours (list of (x, y)), curves sampled."""
    tokens = tokenize(d)
    contours = []
    cur = []
    i = 0
    x = y = 0.0
    sx = sy = 0.0
    cmd = None
    while i < len(tokens):
        t = tokens[i]
        if isinstance(t, str):
            cmd = t.upper()
            i += 1
            if cmd == 'Z':
                if cur:
                    contours.append(cur)
                    cur = []
                x, y = sx, sy
                continue
        if cmd is None:
            i += 1
            continue
        if cmd == 'M':
            x, y = tokens[i], tokens[i + 1]; i += 2
            if cur:
                contours.append(cur)
            cur = [(x, y)]
            sx, sy = x, y
            cmd = 'L'
        elif cmd == 'L':
            x, y = tokens[i], tokens[i + 1]; i += 2
            cur.append((x, y))
        elif cmd == 'Q':
            cx, cy = tokens[i], tokens[i + 1]
            x2, y2 = tokens[i + 2], tokens[i + 3]; i += 4
            for s in range(1, SAMPLES + 1):
                tt = s / SAMPLES
                mt = 1 - tt
                cur.append((mt * mt * x + 2 * mt * tt * cx + tt * tt * x2,
                            mt * mt * y + 2 * mt * tt * cy + tt * tt * y2))
            x, y = x2, y2
        elif cmd == 'C':
            c1x, c1y = tokens[i], tokens[i + 1]
            c2x, c2y = tokens[i + 2], tokens[i + 3]
            x2, y2 = tokens[i + 4], tokens[i + 5]; i += 6
            for s in range(1, SAMPLES + 1):
                tt = s / SAMPLES
                mt = 1 - tt
                cur.append((mt**3 * x + 3 * mt * mt * tt * c1x + 3 * mt * tt * tt * c2x + tt**3 * x2,
                            mt**3 * y + 3 * mt * mt * tt * c1y + 3 * mt * tt * tt * c2y + tt**3 * y2))
            x, y = x2, y2
        else:
            i += 1
    if cur:
        contours.append(cur)
    return [c for c in contours if len(c) >= 3] or contours


def inside_contour(c, px, py):
    inside = False
    n = len(c)
    j = n - 1
    for i in range(n):
        xi, yi = c[i]
        xj, yj = c[j]
        if (yi > py) != (yj > py):
            xint = (xj - xi) * (py - yi) / (yj - yi) + xi
            if px < xint:
                inside = not inside
        j = i
    return inside


def dist_to_contour(c, px, py):
    best = float('inf')
    n = len(c)
    j = n - 1
    for i in range(n):
        ax, ay = c[j]
        bx, by = c[i]
        dx, dy = bx - ax, by - ay
        l2 = dx * dx + dy * dy
        t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2))
        cx, cy = ax + t * dx - px, ay + t * dy - py
        d = math.hypot(cx, cy)
        if d < best:
            best = d
        j = i
    return best


class Path:
    def __init__(self, d, style, faction):
        self.faction = faction
        self.is_fill = 'stroke: none' in style
        self.is_stroke = 'fill: none' in style
        self.contours = flatten(d)

    def covers(self, px, py):
        """evenodd union over this path's contours."""
        hit = False
        for c in self.contours:
            if inside_contour(c, px, py):
                hit = not hit
        return hit

    def distance(self, px, py):
        return min(dist_to_contour(c, px, py) for c in self.contours)


GROUP = re.compile(r'<g data-name="([^"]+)"[^>]*class="element-group ([^"]*)"[^>]*>(.*?)</g>', re.S)
PATH = re.compile(r'<path[^>]*\sd="([^"]*)"[^>]*\sstyle="([^"]*)"')
CIRCLE = re.compile(r'<circle[^>]*\scx="([^"]*)"\s+cy="([^"]*)"\s+r="([^"]*)"[^>]*\sstyle="([^"]*)"')


def parse(svg):
    paths = []
    disks = []
    for gm in GROUP.finditer(svg):
        name, cls, body = gm.group(1), gm.group(2), gm.group(3)
        if 'faction-border-' not in cls:
            continue
        for pm in PATH.finditer(body):
            paths.append(Path(pm.group(1), pm.group(2), name))
        for cm in CIRCLE.finditer(body):
            style = cm.group(4)
            if 'fill: none' in style:
                continue  # invisible geometry
            disks.append((name, float(cm.group(1)), float(cm.group(2)), float(cm.group(3))))
    return paths, disks


def main(path):
    with open(path, encoding='utf-8') as f:
        svg = f.read()
    paths, disks = parse(svg)
    fills = [p for p in paths if p.is_fill]
    strokes = [p for p in paths if p.is_stroke]
    print(f'factions with fills: {len(set(p.faction for p in fills))}, '
          f'fill paths: {len(fills)}, stroke paths: {len(strokes)}, disks: {len(disks)}')

    # cache foreign fills per faction
    by_faction = {}
    for f in fills:
        by_faction.setdefault(f.faction, []).append(f)

    violations = 0
    worst = []
    for s in strokes:
        foreign = [f for f in fills if f.faction != s.faction]
        if not foreign:
            continue
        # bounding box prefilter per foreign fill
        boxes = []
        for f in foreign:
            xs = [p[0] for c in f.contours for p in c]
            ys = [p[1] for c in f.contours for p in c]
            boxes.append((min(xs), min(ys), max(xs), max(ys)))
        for ci in range(len(s.contours)):
            c = s.contours[ci]
            for i in range(len(c) - 1):
                mx = (c[i][0] + c[i + 1][0]) / 2
                my = (c[i][1] + c[i + 1][1]) / 2
                for k, f in enumerate(foreign):
                    b = boxes[k]
                    if not (b[0] - 1 <= mx <= b[2] + 1 and b[1] - 1 <= my <= b[3] + 1):
                        continue
                    if f.covers(mx, my):
                        d = f.distance(mx, my)
                        if d > EPS:
                            violations += 1
                            if len(worst) < 12:
                                worst.append((s.faction, f.faction, round(mx, 2), round(my, 2), round(d, 3)))

    disk_viol = []
    partial = []
    for faction, cx, cy, r in disks:
        dmin = float('inf')
        covered_by = None
        for f in fills:
            d = f.distance(cx, cy)
            if d < dmin:
                dmin = d
            if f.covers(cx, cy) and d > EPS:
                covered_by = f.faction
        if covered_by:
            disk_viol.append((faction, covered_by, cx, cy, r))
        elif dmin < r:
            # Informational: centre is outside, but the disk's radius still
            # reaches into a fill -> a partial second fill (stacked opacity).
            partial.append((faction, cx, cy, r, round(dmin, 3)))

    print(f'STROKE-inside-foreign-FILL violations: {violations}')
    for w in worst:
        print('   stroke of', w[0], 'inside fill of', w[1], 'at', (w[2], w[3]), 'depth', w[4])
    print(f'DISK-inside-any-FILL violations: {len(disk_viol)}')
    for v in disk_viol[:12]:
        print('   disk of', v[0], 'inside fill of', v[1], 'at', (v[2], v[3]), 'r', v[4])
    print(f'DISK-partially-overlapping-a-FILL (informational): {len(partial)}')
    for v in partial[:12]:
        print('   disk of', v[0], 'at', (v[2], v[3]), 'r', v[4], 'touches fill at', v[5])
    return 0 if violations == 0 and not disk_viol else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1]))
