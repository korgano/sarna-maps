import { BorderEdgeLoop } from '../../../compute';
import {
  Point2d,
  pointOnCubicBezierCurve,
  pointOnQuadraticBezierCurve,
  System,
} from '../../../common';
import { polygonContains } from '../../../common/math-2d/polygon-contains';
import { EMPTY_FACTION } from '../../../compute/constants';
import { findPocketHoles, isLoopClosed, onContour } from './normalize-border-loops';
import { generateSectionPath } from './generate-section-path';

/**
 * Geometric constraints that keep FILLS and BORDER STROKES from overlapping.
 *
 * Every faction emits two kinds of geometry from the same separated loops:
 *  - territory FILLS (closed loops + evenodd pocket holes)
 *  - border STROKES (the loop contours, drawn as lines)
 *
 * Separation pulls each faction's copy of a shared border towards its own
 * systems, but the pulled copies can still cross on convoluted borders or
 * where the neighbour-safety guard froze one side. Where that happens a
 * stroke ends up painted INSIDE a foreign faction's fill (and vice versa),
 * so the later layer overdraws the earlier one.
 *
 * The constraint is resolved in favour of the fills ("fills win"):
 *  - `trimStrokeAgainstRegions` rewrites a stroke so it never runs through a
 *    foreign faction's fill — the overlapping stretch is dropped and the
 *    remaining stretches are emitted as separate paths.
 *  - `anyRegionCovers` tells whether a point (e.g. a radius-disk system
 *    position) is already enclosed by filled territory, in which case the
 *    disk must not be emitted: a disk is a fill too, and two fills must
 *    never stack.
 *
 * Both helpers work on the SAME sampled geometry (curves are sampled with
 * `loopToPoints`, mirroring `generateSectionPath`), so a stroke and the fill
 * that shares its contour agree exactly instead of drifting apart.
 */

/**
 * Points sampled per bezier segment when loops are flattened to point chains.
 * Kept deliberately fine: an unchanged stroke is emitted as the true bezier
 * while containment is tested on this chord chain, so the chord-vs-curve
 * sag is the residual overlap budget (8 samples => well under a tenth of a
 * map unit for the tensions used by border separation).
 */
const CURVE_SAMPLES = 8;

/**
 * Distance (map units) below which a point counts as lying ON a fill
 * contour instead of strictly inside it. Twin borders are pulled apart by
 * `borderSeparation` (1.0 by default, i.e. 0.5 per side), so anything well
 * below that — including coincident twins from the same welded section —
 * must be treated as "on the line" and left alone, otherwise legitimate
 * outlines that follow a foreign fill's boundary would be trimmed away.
 */
const BOUNDARY_EPS = 0.01;

export interface FillBBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface FillEntry {
  factionKey: string;
  loop: BorderEdgeLoop;
  holes: Array<BorderEdgeLoop>;
  /** Rendered path of the outer contour (curves, matching generateSectionPath). */
  pathD: string;
  /** Rendered paths of the pocket holes, empties already filtered out. */
  holePathDs: Array<string>;
  /**
   * Outer contour first, then each hole, as point chains in MAP coordinates
   * (y NOT flipped — same space as loop nodes and system x/y).
   */
  contours: Array<Array<Point2d>>;
  bbox: FillBBox;
}

export interface FillRegion {
  factionKey: string;
  entries: Array<FillEntry>;
  bbox: FillBBox;
}

function isValidPoint(p?: Point2d): boolean {
  return !!p && isFinite(p.x) && isFinite(p.y);
}

/**
 * Flattens a border loop into a point chain that follows the exact geometry
 * `generateSectionPath` renders (straight, quadratic or cubic segments), so
 * containment tests see the same curve the SVG will paint.
 *
 * A geometrically closed loop ends on its own first point.
 */
export function loopToPoints(loop: BorderEdgeLoop, renderCurves: boolean, samplesPerCurve = CURVE_SAMPLES): Array<Point2d> {
  const points: Array<Point2d> = [];
  if (!loop.edges || loop.edges.length === 0) {
    return points;
  }
  for (const edge of loop.edges) {
    if (points.length === 0) {
      points.push({ x: edge.node1.x, y: edge.node1.y });
    }
    const p0 = { x: edge.node1.x, y: edge.node1.y };
    const p3 = { x: edge.node2.x, y: edge.node2.y };
    const hasC1 = !!edge.n1c2;
    const hasC2 = !!edge.n2c1;
    const validC1 = isValidPoint(edge.n1c2);
    const validC2 = isValidPoint(edge.n2c1);
    // Branch order mirrors generateSectionPath exactly (including its
    // "one control point present but invalid -> straight line" fallback).
    if (renderCurves && hasC1 && hasC2 && validC1 && validC2) {
      for (let s = 1; s <= samplesPerCurve; s++) {
        points.push(pointOnCubicBezierCurve(p0, edge.n1c2 as Point2d, edge.n2c1 as Point2d, p3, s / samplesPerCurve));
      }
    } else if (renderCurves && hasC1 && !hasC2 && validC1) {
      for (let s = 1; s <= samplesPerCurve; s++) {
        points.push(pointOnQuadraticBezierCurve(p0, edge.n1c2 as Point2d, p3, s / samplesPerCurve));
      }
    } else if (renderCurves && !hasC1 && hasC2 && validC2) {
      for (let s = 1; s <= samplesPerCurve; s++) {
        points.push(pointOnQuadraticBezierCurve(p0, edge.n2c1 as Point2d, p3, s / samplesPerCurve));
      }
    } else {
      points.push(p3);
    }
  }
  return points;
}

/**
 * Builds the rendered fill entries (outer contour + pocket holes) for one
 * faction. This is the single source of truth for BOTH the emitted fill
 * markup and the geometric containment/trimming tests — fills and strokes
 * must never be derived from two different loop filters.
 */
export function buildFillEntries(
  factionKey: string,
  isDisputed: boolean,
  loops: Array<BorderEdgeLoop>,
  allLoops: Record<string, Array<BorderEdgeLoop>>,
  renderCurves: boolean,
  systemsByFaction: Record<string, Array<System>> = {},
): Array<FillEntry> {
  const candidates: Array<BorderEdgeLoop> = [];
  for (const borderLoop of loops) {
    if ([undefined, EMPTY_FACTION].includes(borderLoop.innerAffiliation)) {
      continue;
    }
    if (!isDisputed && (borderLoop.innerAffiliation || '').toUpperCase() !== factionKey.toUpperCase()) {
      continue;
    }
    if (!isLoopClosed(borderLoop)) {
      continue;
    }
    const pathD = generateSectionPath(borderLoop, renderCurves);
    if (!pathD.trim()) {
      continue;
    }
    candidates.push(borderLoop);
  }
  if (candidates.length === 0) {
    return [];
  }

  const pocketHoles = findPocketHoles(candidates, allLoops, factionKey);
  // Never cut a pocket hole out of the parent's fill that contains one of the
  // parent's own systems. A foreign loop that geometrically covers a system the
  // parent faction owns (a system-vs-territory containment mismatch) is not an
  // empty enclave — admitting it as a hole would swallow the parent's territory
  // around its own system, leaving a border stroke with no fill underneath and
  // the system dot surrounded by white (the LC Tamar/Kobe symptom).
  const parentSystems = systemsByFaction[factionKey] || [];
  const holesExcludingOwnSystems = pocketHoles.filter((hole) => {
    const holePts = hole.edges.map((e) => ({ x: e.node1.x, y: e.node1.y }));
    return !parentSystems.some((s) => {
      const p = { x: s.x, y: s.y };
      return polygonContains(holePts, p) || onContour(holePts, p);
    });
  });

  return candidates.map((loop) => {
    const entryPts = loop.edges.map((e) => e.node1);
    const holes = holesExcludingOwnSystems.filter(
      (hole) =>
        hole.edges.length > 0 &&
        hole.edges.every((e) => {
          const p = { x: e.node1.x, y: e.node1.y };
          // Same on-contour tolerance findPocketHoles uses (1e-6): a valid
          // pocket hole whose sampled vertices graze the parent contour must
          // not be dropped by a strict point-in-polygon test.
          return polygonContains(entryPts, p) || onContour(entryPts, p);
        }),
    );
    const holePathDs = holes
      .map((hole) => generateSectionPath(hole, renderCurves))
      .filter((d) => d.trim());
    const contours = [
      loopToPoints(loop, renderCurves),
      ...holes.map((hole) => loopToPoints(hole, renderCurves)),
    ];
    return {
      factionKey,
      loop,
      holes,
      pathD: generateSectionPath(loop, renderCurves),
      holePathDs,
      contours,
      bbox: bboxOfContours(contours),
    };
  });
}

/** Groups per-faction fill entries into regions used by the geometric checks. */
export function buildFillRegions(entriesByKey: Record<string, Array<FillEntry>>): Array<FillRegion> {
  const regions: Array<FillRegion> = [];
  for (const [factionKey, entries] of Object.entries(entriesByKey)) {
    if (!entries || entries.length === 0) {
      continue;
    }
    const bbox = entries[0].bbox;
    const union: FillBBox = { ...bbox };
    for (const entry of entries) {
      union.minX = Math.min(union.minX, entry.bbox.minX);
      union.minY = Math.min(union.minY, entry.bbox.minY);
      union.maxX = Math.max(union.maxX, entry.bbox.maxX);
      union.maxY = Math.max(union.maxY, entry.bbox.maxY);
    }
    regions.push({ factionKey, entries, bbox: union });
  }
  return regions;
}

export interface FillOverlap {
  factionA: string;
  factionB: string;
  detail: string;
}

/**
 * Detects faction pairs whose filled territories overlap.
 *
 * Two factions overlap when a vertex of one faction's filled contour lies
 * strictly inside the other faction's effective fill (outer contour minus
 * pocket holes — the same evenodd area the renderer paints). Shared borders
 * only touch, so strict interior containment means a genuine overlap.
 *
 * @returns One conflict per overlapping faction pair; empty array means no overlaps.
 */
export function detectOverlappingRegions(regions: Array<FillRegion>): Array<FillOverlap> {
  const conflicts: Array<FillOverlap> = [];
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const overlap = findOverlap(regions[i], regions[j]);
      if (overlap) {
        conflicts.push(overlap);
      }
    }
  }
  return conflicts;
}

function findOverlap(a: FillRegion, b: FillRegion): FillOverlap | null {
  const detail = describeOverlap(a, b) ?? describeOverlap(b, a);
  if (!detail) {
    return null;
  }
  return { factionA: a.factionKey, factionB: b.factionKey, detail };
}

function describeOverlap(a: FillRegion, b: FillRegion): string | null {
  // True when a filled point of faction A is covered by faction B's fill.
  for (const entry of b.entries) {
    for (const contour of entry.contours) {
      if (contour.length < 3) continue;
      for (const p of contour) {
        if (regionCovers(a, p, BOUNDARY_EPS)) {
          return `faction "${b.factionKey}" territory contains point (${p.x}, ${p.y}) inside faction "${a.factionKey}" territory`;
        }
      }
    }
  }
  return null;
}

/** True when p is painted by this region's fills (evenodd: outer minus holes). */
export function regionCovers(region: FillRegion, p: Point2d, eps = BOUNDARY_EPS): boolean {
  for (const entry of region.entries) {
    if (!bboxContainsPoint(entry.bbox, p, eps)) {
      continue;
    }
    if (!contoursCover(entry.contours, p)) {
      continue;
    }
    // On the contour (or within eps of it) is NOT "inside": strokes that
    // legitimately follow a foreign fill's boundary must survive.
    if (distanceToContours(entry.contours, p) <= eps) {
      continue;
    }
    return true;
  }
  return false;
}

/** True when p is painted by ANY faction's fills. Used for disk suppression. */
export function anyRegionCovers(regions: Array<FillRegion>, p: Point2d, eps = BOUNDARY_EPS): boolean {
  for (const region of regions) {
    if (!bboxContainsPoint(region.bbox, p, eps)) {
      continue;
    }
    if (regionCovers(region, p, eps)) {
      return true;
    }
  }
  return false;
}

export interface TrimResult {
  changed: boolean;
  pieces: Array<Array<Point2d>>;
}

/**
 * Post-processing intersection check between a stroke path and every
 * FOREIGN faction's fill path.
 *
 * When the stroke crosses into a foreign fill the interior stretch is
 * dropped (the fill is authoritative) and the stroke is emitted as the
 * remaining pieces. A stroke that never leaves the outside of a foreign
 * fill — including one that runs exactly along a foreign contour — is
 * returned untouched so curves and closure are preserved.
 *
 * @param points Stroke point chain in map coordinates (closed loops already
 *   end on their first point)
 * @param regions All factions' fill regions; pass foreign ones only
 */
export function trimStrokeAgainstRegions(
  points: Array<Point2d>,
  regions: Array<FillRegion>,
  eps = BOUNDARY_EPS,
): TrimResult {
  if (points.length < 2 || regions.length === 0) {
    return { changed: false, pieces: [points] };
  }
  const strokeBox = bboxOfContours([points]);
  let pieces: Array<Array<Point2d>> = [points];
  let changed = false;
  for (const region of regions) {
    if (!boxesIntersect(strokeBox, region.bbox)) {
      continue;
    }
    const next: Array<Array<Point2d>> = [];
    for (const piece of pieces) {
      const result = clipPieceAgainstRegion(piece, region, eps);
      if (result.changed) {
        changed = true;
      }
      for (const trimmed of result.pieces) {
        if (trimmed.length >= 2) {
          next.push(trimmed);
        }
      }
    }
    pieces = next;
    if (pieces.length === 0) {
      break;
    }
  }
  if (!changed) {
    return { changed: false, pieces: [points] };
  }
  return { changed: true, pieces };
}

/** Renders a trimmed stroke point chain back into an SVG path `d` string. */
export function polylineToPathD(points: Array<Point2d>): string {
  if (points.length < 2) {
    return '';
  }
  let d = ` M${points[0].x.toFixed(2)},${(-points[0].y).toFixed(2)}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L${points[i].x.toFixed(2)},${(-points[i].y).toFixed(2)}`;
  }
  return d;
}

/**
 * Removes collinear and redundant points from a polyline. Points are
 * considered redundant when the turn angle at that point is below
 * `angleEps` radians (i.e. the point lies essentially on the straight line
 * between its neighbors). This dramatically reduces node count in stroked
 * paths that were flattened from bezier curves during dot trimming, without
 * changing the visible geometry.
 *
 * @param points Polyline point chain (may be open or closed)
 * @param angleEps Maximum turn angle (radians) below which a point is
 *   considered collinear and removed. Default 0.001 (~0.06°).
 * @returns Simplified point chain (same array reference when no change)
 */
export function simplifyPolyline(
  points: Array<Point2d>,
  angleEps = 0.01,
): Array<Point2d> {
  if (points.length < 3) {
    return points;
  }
  const simplified: Array<Point2d> = [points[0]];
  let changed = false;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = simplified[simplified.length - 1];
    const curr = points[i];
    const next = points[i + 1];
    // Cross product of (curr-prev) and (next-curr): near zero = collinear
    const v1x = curr.x - prev.x;
    const v1y = curr.y - prev.y;
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;
    const cross = Math.abs(v1x * v2y - v1y * v2x);
    const len1 = Math.sqrt(v1x * v1x + v1y * v1y);
    const len2 = Math.sqrt(v2x * v2x + v2y * v2y);
    if (len1 > 0 && len2 > 0 && cross / (len1 * len2) < angleEps) {
      changed = true; // skip this point (collinear)
    } else {
      simplified.push(curr);
    }
  }
  simplified.push(points[points.length - 1]);
  return changed ? simplified : points;
}

interface ClipResult {
  changed: boolean;
  pieces: Array<Array<Point2d>>;
}

function clipPieceAgainstRegion(piece: Array<Point2d>, region: FillRegion, eps: number): ClipResult {
  const pieceBox = bboxOfContours([piece]);
  if (!boxesIntersect(pieceBox, region.bbox)) {
    return { changed: false, pieces: [piece] };
  }

  // Preserve stroke segments that run alongside faction boundary contours.
  // The hairline gap between parallel border strokes (total gap = borderSeparation
  // map units) must not be clipped away, otherwise adjacent territories would
  // appear as a single overlaid color instead of two parallel lines.
  // BOUNDARY_EPS (0.01) is too tight for real-world coordinate precision; use
  // a broader eps of 0.1 map units to cover the gap while still clipping true
  // crossings into foreign fills.
  const gapEps = 0.1;
  // Access contours from the first entry (regions share contours per faction).
  const regionContours = region.entries.length > 0 ? region.entries[0].contours : [];
  const isNearContour = piece.some((p, pi) => {
    if (pi === 0) return false;
    const a = piece[pi - 1];
    const b = piece[pi];
    const mid = lerpPoint(a, b, 0.5);
    for (const contour of regionContours) {
      if (contour.length < 2) continue;
      for (let i = 0, j = contour.length - 1; i < contour.length; j = i++) {
        const c = contour[j];
        const d = contour[i];
        const dx = d.x - c.x;
        const dy = d.y - c.y;
        const len2 = dx * dx + dy * dy;
        let t = 0;
        if (len2 > 0) {
          const px = mid.x - c.x;
          const py = mid.y - c.y;
          t = (px * dx + py * dy) / len2;
        }
        t = Math.max(0, Math.min(1, t));
        const closestX = c.x + t * dx;
        const closestY = c.y + t * dy;
        const dist2 = (mid.x - closestX) * (mid.x - closestX) + (mid.y - closestY) * (mid.y - closestY);
        if (dist2 <= gapEps * gapEps) return true;
      }
    }
    return false;
  });

  if (isNearContour) {
    return { changed: false, pieces: [piece] };
  }

  const out: Array<Array<Point2d>> = [];
  let current: Array<Point2d> | null = null;
  let changed = false;

  for (let i = 0; i < piece.length - 1; i++) {
    const a = piece[i];
    const b = piece[i + 1];
    const segBox = segmentBox(a, b);
    const relevant = boxesIntersect(segBox, region.bbox);

    // Parameter cuts: segment ends plus every point where the stroke crosses
    // a foreign fill contour.
    const ts: Array<number> = [0, 1];
    if (relevant) {
      for (const entry of region.entries) {
        if (!boxesIntersect(segBox, entry.bbox)) {
          continue;
        }
        for (const contour of entry.contours) {
          collectCrossings(a, b, contour, ts);
        }
      }
      ts.sort((x, y) => x - y);
    }

    for (let k = 0; k < ts.length - 1; k++) {
      const t0 = ts[k];
      const t1 = ts[k + 1];
      if (t1 - t0 <= 1e-12) {
        continue;
      }
      let inside: boolean;
      if (!relevant) {
        // Segment bbox is outside the region's bbox: provably not covered.
        inside = false;
      } else {
        const mid = lerpPoint(a, b, (t0 + t1) * 0.5);
        inside = regionCovers(region, mid, eps);
      }
      if (inside) {
        changed = true;
        current = null;
        continue;
      }
      const start = t0 === 0 ? a : lerpPoint(a, b, t0);
      const end = t1 === 1 ? b : lerpPoint(a, b, t1);
      if (!current) {
        current = [start, end];
        out.push(current);
      } else {
        const last = current[current.length - 1];
        if (Math.abs(last.x - start.x) <= 1e-9 && Math.abs(last.y - start.y) <= 1e-9) {
          current.push(end);
        } else {
          current = [start, end];
          out.push(current);
        }
      }
    }
  }

  if (!changed) {
    return { changed: false, pieces: [piece] };
  }
  return { changed: true, pieces: out.filter((p) => p.length >= 2) };
}

/**
 * A system dot (centre + radius) used to keep border strokes out of it.
 * `strokeClearance` is added on top of the dot radius (the stroke half width)
 * so a stroke that survives a trim sits fully outside the dot.
 */
export interface DotConstraint {
  x: number;
  y: number;
  radius: number;
}

const DEFAULT_STROKE_CLEARANCE = 0.5;

/**
 * Trims stroke geometry so it never runs through (overlaps) a system dot.
 *
 * A border stroke that passes through a system dot paints over the dot's fill
 * and swallows the dot into the boundary — the "faction border stroke
 * overlapping system dot" defect seen on frontier systems such as Lothan on the
 * DC/CFG frontier. Territory borders are supposed to run *around* their own
 * systems; the dots themselves are the authoritative markers (painted later, in
 * the systems layer — see renderBorderLoops markup order). This drops any stroke
 * stretch that falls within (dot radius + stroke clearance) of a dot, mirroring
 * the foreign-fill trim so fills and dots always win over strokes.
 *
 * @param points Stroke point chain in map coordinates (closed chains end on
 *   their first point, same contract as trimStrokeAgainstRegions).
 * @param dots System dots (centre + radius) the stroke must avoid.
 * @param strokeClearance Stroke half width added on top of the dot radius.
 */
export function trimStrokeAgainstDots(
  points: Array<Point2d>,
  dots: Array<DotConstraint>,
  strokeClearance: number = DEFAULT_STROKE_CLEARANCE,
): TrimResult {
  if (points.length < 2 || dots.length === 0) {
    return { changed: false, pieces: [points] };
  }
  const strokeBox = bboxOfContours([points]);
  let pieces: Array<Array<Point2d>> = [points];
  let changed = false;
  for (const dot of dots) {
    const clearance = dot.radius + strokeClearance;
    const dotBox = {
      minX: dot.x - clearance,
      minY: dot.y - clearance,
      maxX: dot.x + clearance,
      maxY: dot.y + clearance,
    };
    if (!boxesIntersect(strokeBox, dotBox)) continue;
    const next: Array<Array<Point2d>> = [];
    for (const piece of pieces) {
      const result = clipPieceAgainstDotClearance(piece, dot, clearance);
      if (result.changed) changed = true;
      for (const kept of result.pieces) {
        if (kept.length >= 2) next.push(kept);
      }
    }
    pieces = next;
    if (pieces.length === 0) break;
  }
  if (!changed) {
    return { changed: false, pieces: [points] };
  }
  return { changed: true, pieces };
}

function clipPieceAgainstDotClearance(
  piece: Array<Point2d>,
  dot: DotConstraint,
  clearance: number,
): ClipResult {
  const out: Array<Array<Point2d>> = [];
  let current: Array<Point2d> | null = null;
  let changed = false;

  for (let i = 0; i < piece.length - 1; i++) {
    const a = piece[i];
    const b = piece[i + 1];
    const ts: Array<number> = [0, 1];
    const interval = clearanceInterval(a, b, dot, clearance);
    if (interval) {
      ts.push(interval[0]);
      ts.push(interval[1]);
    }
    ts.sort((x, y) => x - y);
    const uniq: Array<number> = [];
    for (const t of ts) {
      if (uniq.length === 0 || t - uniq[uniq.length - 1] > 1e-12) {
        uniq.push(t);
      }
    }
    for (let k = 0; k < uniq.length - 1; k++) {
      const t0 = uniq[k];
      const t1 = uniq[k + 1];
      if (t1 - t0 <= 1e-12) continue;
      const mid = lerpPoint(a, b, (t0 + t1) * 0.5);
      const inside =
        (mid.x - dot.x) * (mid.x - dot.x) + (mid.y - dot.y) * (mid.y - dot.y) <= clearance * clearance;
      const start = t0 === 0 ? a : lerpPoint(a, b, t0);
      const end = t1 === 1 ? b : lerpPoint(a, b, t1);
      if (inside) {
        changed = true;
        current = null;
        continue;
      }
      if (!current) {
        current = [start, end];
        out.push(current);
      } else {
        const last = current[current.length - 1];
        if (Math.abs(last.x - start.x) <= 1e-9 && Math.abs(last.y - start.y) <= 1e-9) {
          current.push(end);
        } else {
          current = [start, end];
          out.push(current);
        }
      }
    }
  }

  if (!changed) {
    return { changed: false, pieces: [piece] };
  }
  return { changed: true, pieces: out.filter((p) => p.length >= 2) };
}

/**
 * Parameters [t0, t1] (t along a->b) where the segment enters/exits the
 * clearance disk around the dot; null when the segment misses it entirely or
 * only touches it (no meaningful overlap).
 */
function clearanceInterval(
  a: Point2d,
  b: Point2d,
  dot: DotConstraint,
  clearance: number,
): Array<number> | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const fx = a.x - dot.x;
  const fy = a.y - dot.y;
  const A = dx * dx + dy * dy;
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - clearance * clearance;
  if (A === 0) {
    if (fx * fx + fy * fy <= clearance * clearance) return [0, 1];
    return null;
  }
  const disc = B * B - 4 * A * C;
  if (disc < 0) {
    if (C <= 0) return [0, 1];
    return null;
  }
  const sq = Math.sqrt(disc);
  const t1 = (-B - sq) / (2 * A);
  const t2 = (-B + sq) / (2 * A);
  const lo = Math.max(0, Math.min(t1, t2));
  const hi = Math.min(1, Math.max(t1, t2));
  if (hi - lo <= 1e-12) return null;
  return [lo, hi];
}

/**
 * Collects the parameters (0..1 along a->b) where segment a-b properly
 * crosses one of the contour's edges. Collinear overlaps are skipped on
 * purpose: they have no discrete crossing and are resolved by the
 * boundary-eps test in `regionCovers`.
 */
function collectCrossings(
  a: Point2d,
  b: Point2d,
  contour: Array<Point2d>,
  ts: Array<number>,
): void {
  const abMinX = Math.min(a.x, b.x);
  const abMaxX = Math.max(a.x, b.x);
  const abMinY = Math.min(a.y, b.y);
  const abMaxY = Math.max(a.y, b.y);
  for (let i = 0, j = contour.length - 1; i < contour.length; j = i++) {
    const p = contour[j];
    const q = contour[i];
    if (Math.max(p.x, q.x) < abMinX || Math.min(p.x, q.x) > abMaxX) {
      continue;
    }
    if (Math.max(p.y, q.y) < abMinY || Math.min(p.y, q.y) > abMaxY) {
      continue;
    }
    const rx = b.x - a.x;
    const ry = b.y - a.y;
    const sx = q.x - p.x;
    const sy = q.y - p.y;
    const denom = rx * sy - ry * sx;
    if (Math.abs(denom) < 1e-12) {
      continue;
    }
    const qpx = p.x - a.x;
    const qpy = p.y - a.y;
    const t = (qpx * sy - qpy * sx) / denom;
    if (t <= 1e-9 || t >= 1 - 1e-9) {
      continue;
    }
    const u = (qpx * ry - qpy * rx) / denom;
    if (u < -1e-9 || u > 1 + 1e-9) {
      continue;
    }
    ts.push(t);
  }
}

/** evenodd coverage: inside an odd number of contours (outer minus holes). */
function contoursCover(contours: Array<Array<Point2d>>, p: Point2d): boolean {
  let covered = false;
  for (const contour of contours) {
    if (contour.length >= 3 && polygonContains(contour, p)) {
      covered = !covered;
    }
  }
  return covered;
}

function distanceToContours(contours: Array<Array<Point2d>>, p: Point2d): number {
  let min = Infinity;
  for (const contour of contours) {
    for (let i = 0, j = contour.length - 1; i < contour.length; j = i++) {
      const d = distancePointToSegment(p, contour[j], contour[i]);
      if (d < min) {
        min = d;
        if (min === 0) {
          return 0;
        }
      }
    }
  }
  return min;
}

function distancePointToSegment(p: Point2d, a: Point2d, b: Point2d): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) {
    t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
  }
  const cx = a.x + t * dx - p.x;
  const cy = a.y + t * dy - p.y;
  return Math.sqrt(cx * cx + cy * cy);
}

function lerpPoint(a: Point2d, b: Point2d, t: number): Point2d {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function bboxOfContours(contours: Array<Array<Point2d>>): FillBBox {
  const bbox: FillBBox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const contour of contours) {
    for (const p of contour) {
      if (p.x < bbox.minX) bbox.minX = p.x;
      if (p.y < bbox.minY) bbox.minY = p.y;
      if (p.x > bbox.maxX) bbox.maxX = p.x;
      if (p.y > bbox.maxY) bbox.maxY = p.y;
    }
  }
  return bbox;
}

function segmentBox(a: Point2d, b: Point2d): FillBBox {
  return {
    minX: Math.min(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x),
    maxY: Math.max(a.y, b.y),
  };
}

function boxesIntersect(a: FillBBox, b: FillBBox): boolean {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}

function bboxContainsPoint(bbox: FillBBox, p: Point2d, eps: number): boolean {
  return p.x >= bbox.minX - eps && p.x <= bbox.maxX + eps && p.y >= bbox.minY - eps && p.y <= bbox.maxY + eps;
}
