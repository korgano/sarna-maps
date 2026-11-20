import { BorderDelaunayVertex, BorderEdgeLoop } from '../types';
import {
  addVectors,
  deepCopy,
  extractBorderStateAffiliation,
  movePoint,
  normalizeVector,
  polygonContains,
  scaleVector,
  Vector2d,
} from '../../../common';
import { EMPTY_FACTION, INDEPENDENT } from '../../constants';
import { traceFaction } from '../../../common/utils/faction-traversal-logger';

// Per-node translation cap. Must admit the designed per-side offset
// (borderSeparation x 0.5 = 0.5 at the default) plus sharp-corner miter
// headroom (up to 2 x tension at a reversed perpendicular), otherwise the cap
// — not the tension — dictates the visual gap and parallel borders never get
// enough movement to separate. The neighbor-safety guard below remains the
// real protection against swallowing nearby systems.
const MAX_SHIFT = 2.0;
const NEIGHBOR_SAFETY_MARGIN = 0.08;

/**
 * Cross-faction border separation: minimum distance between borders of
 * adjacent factions, and repulsion strength to push them apart.
 * Prevents border crowding near shared frontiers (e.g. CFG border
 * crowding DC border near Lothan).
 */
const CROSS_FACTION_MIN_DIST = 2.0;
const CROSS_FACTION_REPULSION = 2.0;

/**
 * Default tension for border loop separation.
 *
 * The default of 0.3 is more conservative than the previous 0.5, which
 * prevents excessive edge pulling near dense system clusters that can cause
 * "fills exploding out" artifacts. Maps with very sparse system distribution
 * may benefit from a higher tension value.
 */
export const DEFAULT_BORDER_TENSION = 0.3;

/**
 * Minimum tension below which containment repair stops backing off. At this
 * point the border is essentially at its pre-separation geometry, which
 * (by construction of fillLoops) contains all own-faction systems.
 * Conservative default: 0.05 preserves more visual separation than 0.01.
 */
const MIN_TENSION = 0.05;

/**
 * Tension decay factor per containment-repair iteration. Halving each pass
 * converges quickly while preserving as much visual separation as possible.
 */
const TENSION_DECAY = 0.5;

/**
 * Maximum containment-repair iterations. Guarantees termination even in
 * pathological configurations where no tension value fully contains all
 * systems (e.g. a system geometrically outside its faction's Voronoi cell).
 * Conservative default: stop after a few passes rather than decaying tension
 * to near-zero, preserving border separation quality at the cost of a small
 * containment risk for extremely tight edge cases.
 */
const MAX_REPAIR_ITERATIONS = 4;

/**
 * Radius (map units) within which an own-faction system reduces the pull
 * on a nearby border edge. Systems farther away get full tension; systems
 * at or inside NEIGHBOR_SAFETY_MARGIN get zero tension for that edge.
 */
const OWN_SYSTEM_PROXIMITY_RADIUS = 1.0;

/**
 * Separates border loops from each other by pulling the borders towards their respective
 * faction's systems.
 *
 * Note that each border loop's edges should already be ordered clockwise when executing this function.
 *
 * Shared borders intentionally remain SEPARATED: each faction keeps its own
 * pulled copy, so adjacent territories render as two parallel faction-colored
 * lines with a hairline gap (total gap = 2 x tension). A previous revision
 * snapped shared copies back to a common centroid, which re-converged the
 * lines into coincident double-paint — only the top layer's color survived
 * (e.g. FWL/CC showing CC only) while the overdraw read as double thickness.
 * Convergence is NOT restored: fills tolerate the hairline gap, and the
 * disputed-zone punch-holes tolerate the small contour offset.
 *
 * CONTENTMENT REPAIR: After the initial pull, any own-faction system found
 * outside its faction's separated loops triggers a repair pass: the loops are
 * restored to their pre-separation geometry and re-pulled at reduced tension.
 * This repeats until all own systems are contained or tension decays below
 * MIN_TENSION. This guarantees that separation never ejects an edge system
 * (e.g. Lothan on the DC/CFG frontier) from its own territory.
 *
 * @param loops The border loops by faction (will be modified)
 * @param vertices List of all delaunay vertices
 * @param tension The amount of distance that any given edge will be pulled
 */
export function separateBorderLoops(
  loops: Record<string, Array<BorderEdgeLoop>>,
  vertices: Array<BorderDelaunayVertex>,
  tension = DEFAULT_BORDER_TENSION,
) {
  const allVertices = vertices.map((v) => ({
    x: v.x,
    y: v.y,
    affiliation: v.affiliation,
  }));

  // Snapshot pre-separation geometry for containment-repair restoration.
  const originalLoops = deepCopy(loops);

  let currentTension = tension;
  let excluded: Array<{ x: number; y: number; affiliation: string }> = [];

  for (let iteration = 0; iteration < MAX_REPAIR_ITERATIONS; iteration++) {
    // Restore pre-separation geometry before each pull pass.
    for (const faction of Object.keys(loops)) {
      loops[faction] = deepCopy(originalLoops[faction] || []);
    }

    for (let faction in loops) {
      loops[faction].forEach((loop) => {
        // Pull direction follows the GEOMETRIC owner (system vote inside the
        // loop), not the forced innerAffiliation: a pocket ring built for
        // faction F but enclosing foreign systems (e.g. DC's ring around Kobe)
        // must retreat OUTWARD, away from the pocket — trusting the forced
        // affiliation would drag it inward onto the pocket owner's line and the
        // twins would coincide into single-color overdraw. Falls back to the
        // innerAffiliation comparison when no systems vote (same as before).
        const geometricOwner = loopOwnerBySystems(loop, vertices) ?? loop.innerAffiliation;
        // Use case-insensitive comparison: affiliations may differ in case from
        // the loop's faction key (e.g. AuC vs AUC).
        const isInner = (geometricOwner || '').toUpperCase() === faction.toUpperCase();
        const loopTension = isInner ? currentTension : -currentTension;
        pullEdgeLoop(
          loop,
          vertices,
          allVertices,
          faction,
          loopTension,
          currentTension,
          loops,
        );
      });
    }

    // Check containment: any own-faction system outside all loops of its faction?
    excluded = findExcludedSystems(loops, allVertices);
    if (excluded.length === 0) {
      if (iteration > 0) {
        traceFaction(
          'separate-border-loops.ts',
          `containment-repair:resolved`,
          `resolved after ${iteration} iteration(s) at tension ${currentTension.toFixed(3)}`,
        );
      }
      return;
    }

    // Frontier detection: identify systems on faction boundaries that should
    // influence border framing rather than being fully contained. Systems that
    // are geometric edge systems (fewer than 3 nearest neighbors within
    // PROXIMITY_RADIUS) and have affiliations differing from the dominant
    // faction in their local neighborhood indicate a frontier situation.
    const frontierSystems = excluded.filter((v) => {
      const localCount = allVertices.filter(
        (other) => other !== v &&
        Math.hypot(other.x - v.x, other.y - v.y) < OWN_SYSTEM_PROXIMITY_RADIUS
      ).length;
      // A frontier system has few nearby own-faction systems but is surrounded
      // by foreign-faction systems in its local neighborhood.
      const ownNearby = allVertices.filter(
        (other) => other !== v &&
        other.affiliation === v.affiliation &&
        Math.hypot(other.x - v.x, other.y - v.y) < OWN_SYSTEM_PROXIMITY_RADIUS
      ).length;
      return ownNearby < 2 && localCount > 0 && localCount < 5;
    });

    traceFaction(
      'separate-border-loops.ts',
      `containment-repair:excluded-systems`,
      `iteration=${iteration} tension=${currentTension.toFixed(3)} excluded=${excluded.map((e) => `${e.affiliation}@(${e.x.toFixed(2)},${e.y.toFixed(2)})`).join('; ')}`,
    );

    // Back off tension and try again. If we hit the floor, accept the result
    // (better to under-separate than to eject own systems from territory).
    currentTension *= TENSION_DECAY;
    if (currentTension < MIN_TENSION) {
      traceFaction(
        'separate-border-loops.ts',
        `containment-repair:min-tension-reached`,
        `stopped at min tension ${MIN_TENSION.toFixed(3)} with ${excluded.length} system(s) still excluded`,
      );
      return;
    }
  }
}

/**
 * Finds own-faction systems (vertices) that lie outside ALL closed loops of
 * their own faction. These are systems that separation ejected from their
 * territory — the condition this repair loop exists to prevent.
 *
 * Returns the list of excluded vertices for logging / diagnostics.
 */
function findExcludedSystems(
  loops: Record<string, Array<BorderEdgeLoop>>,
  allVertices: Array<{ x: number; y: number; affiliation: string }>,
): Array<{ x: number; y: number; affiliation: string }> {
  const excluded: Array<{ x: number; y: number; affiliation: string }> = [];

  for (const v of allVertices) {
    const vAff = extractBorderStateAffiliation(v.affiliation, undefined, undefined, 1, true);
    if (!vAff || vAff === EMPTY_FACTION || vAff === INDEPENDENT) continue;

    const factionLoops = loops[vAff];
    if (!factionLoops || factionLoops.length === 0) continue;

    const p = { x: v.x, y: v.y };
    const insideAny = factionLoops.some((loop) => {
      if (!loop.edges || loop.edges.length < 3) return false;
      const pts = loop.edges.map((e) => e.node1);
      return polygonContains(pts, p) || windingNumberContains(pts, p);
    });

    if (!insideAny) {
      excluded.push(v);
    }
  }

  return excluded;
}

/**
 * Votes the geometric owner of a loop by counting Delaunay system positions
 * strictly inside its polygon (same level-1 affiliation extraction as loop
 * assembly). Returns null when no system is inside (e.g. degenerate loops).
 *
 * Containment is `polygonContains` (ray-cast parity) with the winding number
 * as an independent backup: a system the ray cast misses — even crossing
 * counts on self-touching / re-traced contours from assembly or simplify
 * drift — is still counted when its winding number is non-zero, so the vote
 * cannot silently drop the loop's only system and flip the pull direction
 * (wrong owner → inward pull onto the twin line → overlapping borders).
 */
function loopOwnerBySystems(
  loop: BorderEdgeLoop,
  vertices: Array<BorderDelaunayVertex>,
): string | null {
  if (!loop.edges || loop.edges.length < 3) return null;
  const pts = loop.edges.map((e) => e.node1);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (!isFinite(p.x) || !isFinite(p.y)) return null;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const counts = new Map<string, number>();
  for (const v of vertices) {
    if (v.x < minX || v.x > maxX || v.y < minY || v.y > maxY) continue;
    const vAff = extractBorderStateAffiliation(v.affiliation, undefined, undefined, 1, true);
    if (!vAff || vAff === EMPTY_FACTION) continue;
    const p = { x: v.x, y: v.y };
    if (polygonContains(pts, p) || windingNumberContains(pts, p)) {
      counts.set(vAff, (counts.get(vAff) ?? 0) + 1);
    }
  }
  // Deterministic owner pick: highest vote count wins, ties broken by
  // faction key (ascending) so pull direction never depends on map iteration order.
  const sorted = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
  const bestEntry = sorted[0];
  return bestEntry && bestEntry[1] > 0 ? bestEntry[0] : null;
}

/**
 * Winding-number (nonzero rule) point-in-polygon test — the backup to the
 * ray-casting parity test in `polygonContains`. Both agree on simple
 * contours; they diverge only on degenerate ones, where parity flips a
 * genuinely enclosed point to "outside" (a contour re-tracing a region
 * yields an even crossing count but a non-zero winding number).
 */
function windingNumberContains(
  polygon: Array<{ x: number; y: number }>,
  point: { x: number; y: number },
): boolean {
  if (polygon.length < 3) return false;
  let wn = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const ax = polygon[j].x;
    const ay = polygon[j].y;
    const bx = polygon[i].x;
    const by = polygon[i].y;
    if (ay <= point.y && by > point.y) {
      // Upward crossing: point must be left of the directed edge.
      const cross = (bx - ax) * (point.y - ay) - (point.x - ax) * (by - ay);
      if (cross > 0) wn++;
    } else if (by <= point.y && ay > point.y) {
      // Downward crossing: point must be right of the directed edge.
      const cross = (bx - ax) * (point.y - ay) - (point.x - ax) * (by - ay);
      if (cross < 0) wn--;
    }
  }
  return wn !== 0;
}

/**
 * Re-welds consecutive-edge junctions within each loop after separation.
 *
 * Merged loops hold DISTINCT node objects at shared junctions
 * (`edge[i].node2` vs `edge[i+1].node1` are matched by id/coords, never
 * unified), so any per-edge coordinate mutation (pull guards, simplify drift)
 * can split junctions in two and crack every territory corner. Welding both
 * junction copies to their midpoint restores continuity. This runs BEFORE
 * Bezier control-point generation (which happens downstream in
 * `calculateVoronoiBorders`), so controls are derived from welded geometry.
 */
export function weldLoopJoints(loops: Record<string, Array<BorderEdgeLoop>>) {
  for (const faction of Object.keys(loops)) {
    for (const loop of loops[faction]) {
      const n = loop.edges.length;
      if (n === 0) continue;
      for (let i = 0; i < n - 1; i++) {
        weldNodes(loop.edges[i].node2, loop.edges[i + 1].node1);
      }
      // Close the ring when the loop is geometrically closed.
      const first = loop.edges[0].node1;
      const last = loop.edges[n - 1].node2;
      const closed =
        (first as { id?: string }).id !== undefined &&
        (last as { id?: string }).id !== undefined
          ? (first as { id: string }).id === (last as { id: string }).id
          : Math.abs(first.x - last.x) <= 0.000001 && Math.abs(first.y - last.y) <= 0.000001;
      if (closed) {
        weldNodes(last, first);
      }
    }
  }
}

function weldNodes(a: { x: number; y: number }, b: { x: number; y: number }) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  a.x = mx;
  a.y = my;
  b.x = mx;
  b.y = my;
}

function vecLength(v: { a: number; b: number }) {
  return Math.sqrt(v.a * v.a + v.b * v.b);
}

function scaleTo(v: { a: number; b: number }, len: number) {
  const l = vecLength(v);
  if (l === 0) return;
  const s = len / l;
  v.a *= s;
  v.b *= s;
}

/**
 * Distance from point p to the infinite line through a-b, clamped to the
 * segment. Returns 0 when p projects onto the segment interior.
 */
function pointToSegmentDistanceSq(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    const pdx = p.x - a.x;
    const pdy = p.y - a.y;
    return pdx * pdx + pdy * pdy;
  }
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = a.x + t * dx;
  const py = a.y + t * dy;
  const pdx = p.x - px;
  const pdy = p.y - py;
  return pdx * pdx + pdy * pdy;
}

/**
 * Pulls each edge of a single edge loop closer to its same-faction vertex.
 *
 * EDGE-AWARE TENSION: The effective tension for each edge is scaled down
 * based on proximity to own-faction systems. An edge running near an own
 * system gets reduced pull, so the boundary doesn't creep past edge systems
 * even before the containment-repair loop needs to intervene. This is a
 * smooth gradient (not a binary block), preserving visual separation where
 * possible while protecting edge systems.
 *
 * @param loop The loop to modify
 * @param vertices The list of delaunay vertices (systems)
 * @param allVertices All vertices (flattened, for guard checks)
 * @param loopFaction The faction this loop belongs to
 * @param tension The base tension (before proximity modulation)
 * @param baseTension The original requested tension (for repair iterations)
 */
function pullEdgeLoop(
  loop: BorderEdgeLoop,
  vertices: Array<BorderDelaunayVertex>,
  allVertices: Array<{ x: number; y: number; affiliation: string }>,
  loopFaction: string,
  tension: number,
  baseTension: number,
  allLoops: Record<string, Array<BorderEdgeLoop>>,
) {
  // Closed loops wrap around; open chains must NOT wrap (wrapping would move
  // the chain's first node twice and steer by a phantom segment).
  const firstNode = loop.edges.length > 0 ? loop.edges[0].node1 : null;
  const lastNode = loop.edges.length > 0 ? loop.edges[loop.edges.length - 1].node2 : null;
  const isClosed =
    firstNode !== null &&
    lastNode !== null &&
    (((firstNode as { id?: string }).id !== undefined &&
      (lastNode as { id?: string }).id !== undefined &&
      (firstNode as { id: string }).id === (lastNode as { id: string }).id) ||
      (Math.abs(firstNode.x - lastNode.x) <= 0.000001 && Math.abs(firstNode.y - lastNode.y) <= 0.000001));

  for (let curEdgeIdx = 0; curEdgeIdx < loop.edges.length; curEdgeIdx++) {
    const currentEdge = loop.edges[curEdgeIdx];
    const nextEdge =
      curEdgeIdx + 1 < loop.edges.length
        ? loop.edges[curEdgeIdx + 1]
        : isClosed
          ? loop.edges[0]
          : null;
    const translationVector: Vector2d = { a: 0, b: 0 };

    const point1 = currentEdge.node1;
    const point2 = currentEdge.node2;

    const vector1 = { a: point2.x - point1.x, b: point2.y - point1.y };
    const pVector1 = { a: vector1.b, b: -vector1.a };
    normalizeVector(pVector1);
    addVectors(translationVector, pVector1);
    if (nextEdge) {
      const point3 = nextEdge.node2;
      const vector2 = { a: point3.x - point2.x, b: point3.y - point2.y };
      const pVector2 = { a: vector2.b, b: -vector2.a };
      normalizeVector(pVector2);
      addVectors(translationVector, pVector2);
    }

    // --- EDGE-AWARE TENSION MODULATION ---
    // For inner loops (own territory), push the border AWAY from frontier
    // own-faction systems (negative tension) so the boundary bulges outward
    // around them — a convex wrap that keeps systems like Lothan well inside
    // territory instead of pinching inward toward them (concave defect).
    // For outer loops (pocket rings around foreign systems), tension is already
    // negative and pulls inward toward the pocket — keep that behaviour.
    // Systems within NEIGHBOR_SAFETY_MARGIN get zero tension; systems beyond
    // OWN_SYSTEM_PROXIMITY_RADIUS get full tension.
    let edgeTension = tension;
    for (let i = 0; i < allVertices.length; i++) {
      const v = allVertices[i];
      if (v.affiliation !== loopFaction) continue;
      // Distance from system to this edge segment
      const distSq = pointToSegmentDistanceSq(
        { x: v.x, y: v.y },
        currentEdge.node1,
        currentEdge.node2,
      );
      if (distSq <= NEIGHBOR_SAFETY_MARGIN * NEIGHBOR_SAFETY_MARGIN) {
        edgeTension = 0;
        break;
      }
      if (distSq <= OWN_SYSTEM_PROXIMITY_RADIUS * OWN_SYSTEM_PROXIMITY_RADIUS) {
        const dist = Math.sqrt(distSq);
        const multiplier = (dist - NEIGHBOR_SAFETY_MARGIN) /
          (OWN_SYSTEM_PROXIMITY_RADIUS - NEIGHBOR_SAFETY_MARGIN);
        const m = Math.max(0, Math.min(1, multiplier));
        // Inner loops (tension > 0): push AWAY from frontier system → convex boundary.
        // Outer loops (tension < 0): keep pulling inward toward the pocket.
        edgeTension = tension > 0 ? -tension * m : tension * m;
      }
      }

    scaleVector(translationVector, edgeTension);

    // --- CROSS-FACTION BORDER REPULSION ---
    // Push this edge away from nearby borders of other factions to prevent
    // border crowding near shared frontiers (e.g. CFG border crowding DC
    // border near Lothan). Ensures CFG borders stay outside DC borders.
    const edgeMidX = (currentEdge.node1.x + currentEdge.node2.x) * 0.5;
    const edgeMidY = (currentEdge.node1.y + currentEdge.node2.y) * 0.5;
    let repulsionX = 0;
    let repulsionY = 0;
    const minDistSq = CROSS_FACTION_MIN_DIST * CROSS_FACTION_MIN_DIST;
    for (const otherFaction of Object.keys(allLoops)) {
      if (otherFaction === loopFaction) continue;
      const otherLoops = allLoops[otherFaction];
      if (!otherLoops) continue;
      for (const otherLoop of otherLoops) {
        for (const otherEdge of otherLoop.edges) {
          const distSq = pointToSegmentDistanceSq(
            { x: edgeMidX, y: edgeMidY },
            otherEdge.node1,
            otherEdge.node2,
          );
          if (distSq > 0 && distSq < minDistSq) {
            const dist = Math.sqrt(distSq);
            // Closest point on the other edge to this edge's midpoint
            const odx = otherEdge.node2.x - otherEdge.node1.x;
            const ody = otherEdge.node2.y - otherEdge.node1.y;
            const olen2 = odx * odx + ody * ody;
            let ot = 0;
            if (olen2 > 0) {
              ot = ((edgeMidX - otherEdge.node1.x) * odx + (edgeMidY - otherEdge.node1.y) * ody) / olen2;
              ot = Math.max(0, Math.min(1, ot));
            }
            const cx = otherEdge.node1.x + ot * odx;
            const cy = otherEdge.node1.y + ot * ody;
            const dirX = edgeMidX - cx;
            const dirY = edgeMidY - cy;
            const dirLen = Math.sqrt(dirX * dirX + dirY * dirY);
            if (dirLen > 0) {
              const strength = CROSS_FACTION_REPULSION * (1 - dist / CROSS_FACTION_MIN_DIST);
              translationVector.a += (dirX / dirLen) * strength;
              translationVector.b += (dirY / dirLen) * strength;
            }
          }
        }
      }
    }

    const currentX = currentEdge.node2.x;
    const currentY = currentEdge.node2.y;

    // Cap per-node translation magnitude
    if (vecLength(translationVector) > MAX_SHIFT) {
      scaleTo(translationVector, MAX_SHIFT);
    }

    // Repulsion guard: if moving would bring node very close to a vertex of another faction,
    // reduce or zero out the move.
    let blocked = false;
    for (let i = 0; i < allVertices.length; i++) {
      const v = allVertices[i];
      if (v.affiliation === loopFaction) continue;

      const dx0 = v.x - currentX;
      const dy0 = v.y - currentY;
      if (dx0 * dx0 + dy0 * dy0 < NEIGHBOR_SAFETY_MARGIN * NEIGHBOR_SAFETY_MARGIN) {
        blocked = true;
        break;
      }

      const dx = v.x - (currentX + translationVector.a);
      const dy = v.y - (currentY + translationVector.b);
      const dist2 = dx * dx + dy * dy;
      if (dist2 < NEIGHBOR_SAFETY_MARGIN * NEIGHBOR_SAFETY_MARGIN) {
        blocked = true;
        break;
      }
    }

    // Own-system guard: don't move the boundary past an own-faction system.
    // For inner loops we now push AWAY from frontier systems, so this rarely
    // triggers, but it remains a backstop for cases where the containment-
    // repair loop hasn't yet backed off tension enough.
    if (!blocked) {
      const moveLen2 = translationVector.a * translationVector.a + translationVector.b * translationVector.b;
      if (moveLen2 > 0) {
        for (let i = 0; i < allVertices.length; i++) {
          const v = allVertices[i];
          if (v.affiliation !== loopFaction) continue;
          const toSysX = v.x - currentX;
          const toSysY = v.y - currentY;
          const t = (toSysX * translationVector.a + toSysY * translationVector.b) / moveLen2;
          if (t > 0 && t < 1) {
            const projX = currentX + translationVector.a * t;
            const projY = currentY + translationVector.b * t;
            const pdx = v.x - projX;
            const pdy = v.y - projY;
            if (pdx * pdx + pdy * pdy <= NEIGHBOR_SAFETY_MARGIN * NEIGHBOR_SAFETY_MARGIN) {
              blocked = true;
              break;
            }
          }
        }
      }
    }

    if (blocked) {
      translationVector.a = 0;
      translationVector.b = 0;
    }

    movePoint(currentEdge.node2, translationVector);
    currentEdge.n2c1 && movePoint(currentEdge.n2c1, translationVector);
    currentEdge.n2c2 && movePoint(currentEdge.n2c2, translationVector);
    if (nextEdge) {
      movePoint(nextEdge.node1, translationVector);
      nextEdge.n1c1 && movePoint(nextEdge.n1c1, translationVector);
      nextEdge.n1c2 && movePoint(nextEdge.n1c2, translationVector);
    }
  }
}
