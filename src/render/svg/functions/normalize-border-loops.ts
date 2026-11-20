import { BorderEdgeLoop } from '../../../compute';
import { polygonContains } from '../../../common/math-2d/polygon-contains';
import { EMPTY_FACTION, INDEPENDENT } from '../../../compute/constants';

/**
 * Groups per-faction border loops under case-folded keys.
 *
 * Compute emits raw affiliation casing (e.g. `AuC`) while pairing-normalized
 * structures (`systemsByFaction`) use upper-folded keys (`AUC`). Previously
 * each render pass hand-rolled its own `toUpperCase()` aggregation, which
 * drifted apart. All render passes must use this helper.
 *
 * Keys are folded with `trim().toUpperCase()` only — hierarchical keys such
 * as `FWL,Marik` stay intact (no `normalizeFactionKey` comma-splitting here).
 */
export function groupBorderLoopsByUpperKey(
  borderLoops: Record<string, Array<BorderEdgeLoop>>,
): Record<string, Array<BorderEdgeLoop>> {
  const grouped: Record<string, Array<BorderEdgeLoop>> = {};
  for (const [key, loops] of Object.entries(borderLoops)) {
    const upper = key.trim().toUpperCase();
    if (!grouped[upper]) grouped[upper] = [];
    grouped[upper].push(...loops);
  }
  return grouped;
}

interface LoopEndpoints {
  edges: Array<{
    node1: { id?: string; x: number; y: number };
    node2: { id?: string; x: number; y: number };
  }>;
}

/**
 * Shared closed-loop test (id match, else 1e-6 coordinate match).
 * Previously hand-rolled in every render pass with drift risk; all passes
 * must use this helper.
 */
export function isLoopClosed(loop: LoopEndpoints): boolean {
  if (!loop.edges || loop.edges.length === 0) return false;
  const first = loop.edges[0].node1;
  const last = loop.edges[loop.edges.length - 1].node2;
  if (first.id !== undefined && last.id !== undefined) return first.id === last.id;
  return Math.abs(first.x - last.x) <= 0.000001 && Math.abs(first.y - last.y) <= 0.000001;
}

/**
 * Finds foreign-pocket holes for a faction's territory fill: closed loops of
 * OTHER factions that lie FULLY inside the faction's own closed loops
 * (every vertex contained). The surrounding fill must exclude such pockets —
 * otherwise the surrounding color overpaints them (e.g. an LC pocket rendered
 * under DC fill, or Lothan-class single coverage by the wrong faction's loop
 * going unchallenged).
 *
 * Strict full-containment is required: a partially-overlapping contour must
 * NEVER be appended as a hole, because under evenodd it would paint a stray
 * filled region at its own location. This replaces the old key-based disputed
 * hole matching, which appended contours without any geometry check (and
 * could double-append, toggling holes back off).
 *
 * Boundary tolerance: twin pocket loops share exact boundary segments with
 * the surrounding loop (same sections, both factions' builds), so pocket
 * vertices lying ON the parent contour (within 1e-6) count as inside.
 * A strictly-interior centroid is additionally required, which excludes
 * merely-adjacent loops and inverse nesting. Without the tolerance, every
 * real twin pocket is rejected and the overlap it was built to fix survives.
 *
 * @param ownLoops Closed loops of the faction being filled
 * @param allLoops All factions' loops (normalized keys)
 * @param ownKey Normalized key of the faction being filled
 */
export function findPocketHoles(
  ownLoops: Array<BorderEdgeLoop>,
  allLoops: Record<string, Array<BorderEdgeLoop>>,
  ownKey: string,
): Array<BorderEdgeLoop> {
  const closedOwn = ownLoops.filter(isLoopClosed);
  if (closedOwn.length === 0) return [];
  // Bounding boxes per own loop for a cheap precheck.
  const ownBoxes = closedOwn.map((loop) => {
    const pts = loop.edges.map((e) => e.node1);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { pts, minX, minY, maxX, maxY };
  });
  const holes: Array<BorderEdgeLoop> = [];
  for (const [key, loops] of Object.entries(allLoops)) {
    if (key === ownKey) continue;
    // Independent/empty pockets keep their historical behavior (parent fill
    // shows through; they render no fill of their own).
    if (key === EMPTY_FACTION || key === INDEPENDENT) continue;
    for (const candidate of loops) {
      if (!candidate.innerAffiliation || [undefined, EMPTY_FACTION].includes(candidate.innerAffiliation)) continue;
      if (!isLoopClosed(candidate)) continue;
      const cPts = candidate.edges.map((e) => e.node1);
      const centroid = {
        x: cPts.reduce((s, p) => s + p.x, 0) / cPts.length,
        y: cPts.reduce((s, p) => s + p.y, 0) / cPts.length,
      };
      // Fully inside at least one own loop (bbox precheck, then all verts
      // strictly inside or on the contour, plus a strictly-interior centroid).
      // The boundary tolerance (onContour) allows twin pockets whose vertices
      // lie exactly on the parent contour.
      const inside = ownBoxes.some((box) => {
        if (
          !cPts.every((p) => p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY)
        ) {
          return false;
        }
        // Check centroid containment first (handles border-zone systems like
        // Lothan on faction frontiers where vertices may fall outside due to
        // geometric precision, but the system intent is within the faction).
        const centroidInside = polygonContains(box.pts, centroid);
        if (!centroidInside) return false;
        // Secondary: verify that not ALL vertices are outside. If some vertices
        // are inside/on the loop, the candidate has significant overlap and
        // should be admitted as a pocket hole. This prevents "stray fills" from
        // partially-overlapping foreign loops while admitting border-zone cases.
        const someVerticesInside = cPts.some((p) =>
          polygonContains(box.pts, { x: p.x, y: p.y }) || onContour(box.pts, p),
        );
        return someVerticesInside;
      });
      if (inside) holes.push(candidate);
    }
  }
  return holes;
}

/** True when point p lies within 1e-6 of any segment of the contour. */
export function onContour(pts: Array<{ x: number; y: number }>, p: { x: number; y: number }): boolean {
  const tol2 = 0.000001 * 0.000001;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const ax = pts[j].x;
    const ay = pts[j].y;
    const bx = pts[i].x;
    const by = pts[i].y;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = 0;
    if (len2 > 0) {
      t = ((p.x - ax) * dx + (p.y - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
    }
    const cx = ax + t * dx - p.x;
    const cy = ay + t * dy - p.y;
    if (cx * cx + cy * cy <= tol2) return true;
  }
  return false;
}
