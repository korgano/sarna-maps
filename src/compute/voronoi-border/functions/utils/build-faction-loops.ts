import { BorderDelaunayVertex, BorderSection, VoronoiBorderEdge, VoronoiBorderNode } from '../../types';
import { extractBorderStateAffiliation, lineSegmentIntersection, logger, pointIsLeftOfLine, polygonContains } from '../../../../common';
import { reverseEdges } from './reverse-edges';
import { reverseEdgeLoop } from './reverse-edge-loop';
import { ensureEdgeLoopClockwiseOrder } from '../ensure-edge-loop-clockwise-order';
import { coordKey } from './node-coord-key';
import { EMPTY_FACTION } from '../../../constants';

/**
 * Two endpoints count as the same node when their ids match *or* (as a
 * defensive fallback) when they sit at approximately the same coordinate.
 * The id-based match is canonical after `normalizeBorderNodeIds`, but the
 * coordinate fallback protects against floating-point drift that can occur
 * during simplify/pass operations. Uses a tolerance-based distance check
 * rather than exact coordKey matching to handle small coordinate variations.
 */
/**
 * Averages the coordinates of every same-id endpoint across the given
 * sections, in place. See the call-site comment in `buildFactionLoops`.
 */
export function weldSectionJunctions(sections: Array<BorderSection>): void {
  const byId = new Map<string, Array<VoronoiBorderNode>>();
  for (const section of sections) {
    for (const edge of section.edges) {
      for (const node of [edge.node1, edge.node2]) {
        if (!node || !isFinite(node.x) || !isFinite(node.y)) continue;
        const list = byId.get(node.id) || [];
        list.push(node);
        byId.set(node.id, list);
      }
    }
  }
  for (const refs of byId.values()) {
    if (refs.length < 2) continue;
    let sx = 0;
    let sy = 0;
    for (const r of refs) {
      sx += r.x;
      sy += r.y;
    }
    const mx = sx / refs.length;
    const my = sy / refs.length;
    for (const r of refs) {
      r.x = mx;
      r.y = my;
    }
  }
}

/**
 * Maximum closing-chord length (map units) for stranded chains. A chain whose
 * own free ends nearly meet (observed: FWL's 81-edge border on a 0.35 gap,
 * CFG's cluster chain on a 3.0 gap) is a closure failure from simplify drift
 * or a dropped short segment — not a real coastline. Real coastlines end far
 * apart. Length alone is NOT the safety check: `trySelfClose` additionally
 * requires a border-free, foreign-system-free corridor (below), so the bound
 * only limits visual distortion, and genuine dead-ends stay open.
 */
const CHORD_MAX_LENGTH = 8;

/**
 * Default shared-edge ratio at which a SHORTER closed loop counts as a
 * near-duplicate of a longer one and is dropped (see `isNearDuplicate`).
 * Tunable per call through `buildFactionLoops`' 4th parameter; the default
 * stays 90% so existing maps render unchanged.
 */
export const NEAR_DUPLICATE_THRESHOLD = 0.9;

/**
 * Attempts to close a stranded chain with a synthetic chord between its own
 * free ends. Returns true when closed (seed mutated: chord appended, flagged
 * loop, endpoints re-derived).
 *
 * Safety (all required — first principles for topology preservation):
 * 1. Gap within CHORD_MAX_LENGTH (bounds distortion).
 * 2. The chord crosses NO existing border segment (closing must not cut
 *    through another border — shared endpoints excluded).
 * 3. No FOREIGN-affiliation system near the chord corridor (closing must not
 *    swallow systems the border was routed around; own-faction systems may be
 *    enclosed — that is the point of closing).
 * The chord's left/right affiliations stay empty so it never votes in owner
 * computation.
 */
function trySelfClose(
  seed: BorderSection,
  sections: Array<BorderSection>,
  vertices: Array<BorderDelaunayVertex>,
  faction: string,
): boolean {
  if (seed.edges.length === 0) return false;
  const start = seed.edges[0].node1;
  const end = seed.edges[seed.edges.length - 1].node2;
  if (!isFinite(start.x) || !isFinite(start.y) || !isFinite(end.x) || !isFinite(end.y)) {
    return false;
  }
  const gap = Math.hypot(end.x - start.x, end.y - start.y);
  if (gap > CHORD_MAX_LENGTH) return false;

  const chord = { p1: { x: start.x, y: start.y }, p2: { x: end.x, y: end.y } };
  const endTol2 = 1e-12;
  const nearEnd = (p: { x: number; y: number }) =>
    (p.x - start.x) * (p.x - start.x) + (p.y - start.y) * (p.y - start.y) <= endTol2 ||
    (p.x - end.x) * (p.x - end.x) + (p.y - end.y) * (p.y - end.y) <= endTol2;

  // Guard 2: no border crossings (all sections, all factions).
  for (const section of sections) {
    for (const edge of section.edges) {
      const hit = lineSegmentIntersection(
        chord,
        { p1: { x: edge.node1.x, y: edge.node1.y }, p2: { x: edge.node2.x, y: edge.node2.y } },
      );
      if (hit && !nearEnd(hit)) return false;
    }
  }

  // Guard 3: no foreign systems in the chord corridor.
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  const corridorR = gap / 2 + 1;
  const factionUpper = faction.toUpperCase();
  for (const v of vertices) {
    const dx = v.x - midX;
    const dy = v.y - midY;
    if (dx * dx + dy * dy > corridorR * corridorR) continue;
    const vAff = extractBorderStateAffiliation(v.affiliation, undefined, undefined, 1, true);
    if (!vAff || vAff === EMPTY_FACTION) continue;
    if (vAff.toUpperCase() !== factionUpper && !vAff.toUpperCase().includes(factionUpper)) {
      return false;
    }
  }

  const lastEdge = seed.edges[seed.edges.length - 1];
  seed.edges.push({
    ...lastEdge,
    id: `close-${seed.id}`,
    node1: end,
    node2: start,
    leftAffiliation: '',
    rightAffiliation: '',
    length: gap,
  });
  seed.node1 = seed.edges[0].node1;
  seed.node2 = start;
  seed.isLoop = true;
  logger.debug(
    'build-faction-loops.ts',
    `Self-closed stranded chain with ${gap.toFixed(4)}-unit chord`,
    faction,
    seed.id,
  );
  return true;
}

function sameNode(a: VoronoiBorderNode, b: VoronoiBorderNode): boolean {
  if (a.id === b.id) return true;
  // Tolerance-based coordinate comparison: match if within 0.000001 units.
  // This handles floating-point drift from simplify/pass operations while
  // still preventing false matches from widely-different coordinates.
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  return dx <= 0.000001 && dy <= 0.000001;
}

/**
 * Direction-independent identity contribution of an edge's Bezier control
 * points (n1c1/n1c2/n2c1/n2c2), keyed with the same 6dp rounding as node
 * coordinates. Control points are REQUIRED for identity: node ids (and even
 * endpoint pairs) are not precise enough on their own — post-simplify id
 * collisions make two DIFFERENT physical segments share one id, and an
 * id-only key then silently dropped one of them, punching a gap in the loop.
 *
 * Reversal must not change identity: `swapEdgeNodes` mirrors the arrangement
 * (n1c1<->n2c2, n1c2<->n2c1), so the canonical form is the lexicographically
 * smaller of the forward and mirrored tuples — a segment reversed onto its
 * own twin still keys identically.
 */
function controlPointsKey(edge: VoronoiBorderEdge): string {
  const cp = (p?: { x: number; y: number }) => (p ? coordKey(p.x, p.y) : '_');
  const forward = [edge.n1c1, edge.n1c2, edge.n2c1, edge.n2c2].map(cp).join('|');
  const mirrored = [edge.n2c2, edge.n2c1, edge.n1c2, edge.n1c1].map(cp).join('|');
  return forward <= mirrored ? forward : mirrored;
}

/**
 * Canonical, direction-independent identity for a border edge.
 *
 * `generateBorderEdges` builds ids as `[nodeIdx, neighborIdx].sort().join('-')`,
 * so the id ALREADY denotes an unordered node pair: `A -> B` and `B -> A` share
 * one id. `reverseEdges` deliberately preserves it across a flip. That makes the
 * id the precise identity of a physical segment, and it stays correct even for
 * synthetic nodes whose coordinates were moved by the simplify passes.
 *
 * Identity additionally includes the edge's Bezier control points (see
 * `controlPointsKey`): edges sharing an id but carrying different curves are
 * distinct segments and both must survive dedupe.
 *
 * Edges without an id fall back to their unordered coordinate pair.
 */
function undirectedEdgeKey(edge: VoronoiBorderEdge): string {
  const controls = controlPointsKey(edge);
  if (edge.id) {
    return `id:${edge.id}|cp:${controls}`;
  }
  const a = coordKey(edge.node1.x, edge.node1.y);
  const b = coordKey(edge.node2.x, edge.node2.y);
  return a < b ? `xy:${a}|${b}|cp:${controls}` : `xy:${b}|${a}|cp:${controls}`;
}

/**
 * Removes duplicate edges from an assembled loop, keeping the first occurrence.
 *
 * A section can be merged into a seed that already covers the same physical
 * segment from the opposite direction (`buildFactionLoops` reverses candidates
 * when their endpoints match tail-to-tail). Because `reverseEdges` keeps the
 * edge id intact, the merged loop then holds two edges denoting one segment,
 * and `generateSectionPath` emits — and strokes — that sub-path twice.
 *
 * @param loop The loop whose edge list will be de-duplicated in place
 * @returns The number of edges removed
 */
export function dedupeLoopEdges(loop: BorderSection): number {
  const seen = new Set<string>();
  const before = loop.edges.length;
  loop.edges = loop.edges.filter((edge) => {
    const key = undirectedEdgeKey(edge);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  return before - loop.edges.length;
}

/**
 * Builds closed border loops for a single faction by merging all of its
 * sections together.
 *
 * The merge is driven by an endpoint -> sections index keyed on node `id`
 * (stable strings) rather than by always extending `sections[0]`. This
 * guarantees every section is visited and merged regardless of seed order,
 * and removes the previous spin-to-the-cap failure mode: when a section
 * cannot be merged (disconnected island / T-junction whose free ends touch
 * other factions) it is emitted as a stranded open loop instead of being
 * dropped, and the algorithm advances to the next seed.
 */
export function buildFactionLoops(
  faction: string,
  sections: Array<BorderSection>,
  vertices: Array<BorderDelaunayVertex>,
  nearDuplicateThreshold: number = NEAR_DUPLICATE_THRESHOLD,
) {
  // Re-weld junction coordinates by node id BEFORE matching. Simplify passes
  // mutate the distinct node objects of shared junctions independently, so
  // copies of one physical point drift apart and endpoint matching (by id or
  // rounded coords) misses true joints — entire factions collapse into single
  // uncloseable chains. Averaging same-id endpoints back together restores
  // exact id-matches. (Simplify-created nodes carry fresh unique ids, so
  // same-id averaging never fuses distinct points.)
  weldSectionJunctions(sections);

  // search sections for only this faction
  const filteredSections = sections.filter(
    (section) => section.affiliation1 === faction || section.affiliation2 === faction,
  );

  // Clone sections and their edges for isolation: each faction gets its own edge
  // objects so that in-place mutations (reverseEdges/swapEdgeNodes during merge
  // and orientation) don't leak to other factions' loop building. Edge clones
  // also DEEP-CLONE node objects AND all four Bezier control points
  // (n1c1/n1c2/n2c1/n2c2) so that separateBorderLoops — which mutates node
  // coordinates and control-point coordinates in-place — cannot undo one
  // faction's separation by moving the same shared node/control-point object in
  // the opposite direction for another faction. Shallow-cloned control points
  // were the root cause of visible border overlap on curves: adjacent borders'
  // control points got pulled back to the original shared border while their
  // (deep-cloned) endpoints separated, so the rendered curves converged again.
  const factionSections = filteredSections.map((s) => ({
    ...s,
    edges: s.edges.map((e) => ({
      ...e,
      node1: { ...e.node1 },
      node2: { ...e.node2 },
      ...(e.n1c1 ? { n1c1: { ...e.n1c1 } } : {}),
      ...(e.n1c2 ? { n1c2: { ...e.n1c2 } } : {}),
      ...(e.n2c1 ? { n2c1: { ...e.n2c1 } } : {}),
      ...(e.n2c2 ? { n2c2: { ...e.n2c2 } } : {}),
    })),
  }));

  logger.debug('build-faction-loops.ts', `Building loops for ${faction}: ${factionSections.length} sections`);

  const loops: Array<BorderSection> = [];

  // Endpoint index: coordinate key -> sections still pending. Keyed on a
  // rounded coordinate (see `coordKey`) rather than on node `id` so that two
  // sections meeting at the same physical point are found as candidates even
  // when their node ids differ (the divergence that previously stranded
  // borders as open loops). Storing section *references* (not array indices)
  // keeps the index valid when sections are removed from the active set.
  const nodeKey = (node: VoronoiBorderNode) => coordKey(node.x, node.y);
  const endpointIndex = new Map<string, Set<BorderSection>>();
  const indexEndpoint = (section: BorderSection) => {
    for (const node of [section.node1, section.node2]) {
      const key = nodeKey(node);
      let set = endpointIndex.get(key);
      if (!set) {
        set = new Set();
        endpointIndex.set(key, set);
      }
      set.add(section);
    }
  };
  const deindexEndpoint = (section: BorderSection) => {
    for (const node of [section.node1, section.node2]) {
      const key = nodeKey(node);
      const set = endpointIndex.get(key);
      if (!set) continue;
      set.delete(section);
      if (set.size === 0) endpointIndex.delete(key);
    }
  };
  factionSections.forEach((section) => indexEndpoint(section));

  const active = new Set(factionSections);

  while (active.size > 0) {
    const seed = active.values().next().value!;

    // Already a closed loop - emit and advance.
    if (seed.isLoop) {
      loops.push(seed);
      deindexEndpoint(seed);
      active.delete(seed);
      continue;
    }

    // Find a pending section (other than the seed) sharing an endpoint with
    // the seed, and merge it onto the seed. Repeat until no more merges.
    let mergedAny = false;
    let progress = true;
    while (progress) {
      progress = false;
      const candidateKeys = [nodeKey(seed.node1), nodeKey(seed.node2)];
      outer: for (const key of candidateKeys) {
        const candidates = endpointIndex.get(key);
        if (!candidates) continue;
        for (const candidate of [...candidates]) {
          if (candidate === seed) continue;
          let merged = false;

          if (sameNode(seed.node1, candidate.node1)) {
            seed.edges.unshift(...reverseEdges([...candidate.edges]));
            merged = true;
          } else if (sameNode(seed.node1, candidate.node2)) {
            seed.edges.unshift(...candidate.edges);
            merged = true;
          } else if (sameNode(seed.node2, candidate.node1)) {
            seed.edges.push(...candidate.edges);
            merged = true;
          } else if (sameNode(seed.node2, candidate.node2)) {
            seed.edges.push(...reverseEdges([...candidate.edges]));
            merged = true;
          }

          if (merged) {
            // Remove the candidate entirely (from index + active set).
            deindexEndpoint(candidate);
            active.delete(candidate);
            // Recompute seed endpoints from the merged edge list, then
            // reindex the seed under its (possibly new) node ids.
            seed.node1 = seed.edges[0].node1;
            seed.node2 = seed.edges[seed.edges.length - 1].node2;
            seed.isLoop = sameNode(seed.node1, seed.node2);
            deindexEndpoint(seed);
            indexEndpoint(seed);
            mergedAny = true;
            progress = true;
            if (seed.isLoop) {
              loops.push(seed);
              active.delete(seed);
              deindexEndpoint(seed);
              break outer;
            }
            break outer;
          }
        }
      }
    }

    if (!mergedAny) {
      // Self-closure (guarded; see trySelfClose): a chain whose OWN free ends
      // nearly meet across border-free, foreign-system-free ground is a
      // closure failure from simplify drift or a dropped short segment — not
      // a real coastline. Join the ends so the territory closes (observed:
      // FWL's entire 81-edge border stranded on a 0.35-unit gap; a CFG
      // cluster chain on a 3.0-unit gap).
      if (trySelfClose(seed, sections, vertices, faction)) {
        loops.push(seed);
        deindexEndpoint(seed);
        active.delete(seed);
        continue;
      }
      // Stranded open chain: its free ends connect to no other same-faction
      // section (e.g. disconnected island or T-junction). Emit it rather than
      // dropping it, and advance so we never spin on the same seed.
      // Downgraded to debug because most cases are legitimate coastlines or
      // T-junctions with other factions, not algorithmic failures.
      logger.debug(
        'build-faction-loops.ts',
        'Disputed/stranded open border could not be closed into a loop; emitting as open loop',
        faction,
        seed.id,
      );
      loops.push(seed);
      deindexEndpoint(seed);
      active.delete(seed);
    }
  }

  // Drop duplicate edges BEFORE any geometry is derived: `length`, `minEdgeIdx`
  // and the clockwise-orientation test all read the edge list, so a duplicated
  // segment would otherwise skew the loop length and the winding pivot too.
  let duplicateEdgesRemoved = 0;
  loops.forEach((loop) => {
    const removed = dedupeLoopEdges(loop);
    if (removed > 0 && loop.edges.length > 0) {
      // Re-derive the endpoint handles from the surviving edges.
      loop.node1 = loop.edges[0].node1;
      loop.node2 = loop.edges[loop.edges.length - 1].node2;
      loop.isLoop = sameNode(loop.node1, loop.node2);
    }
    duplicateEdgesRemoved += removed;
  });
  // A loop can be emptied entirely if it consisted only of degenerate edges.
  const nonEmptyLoops = loops.filter((loop) => loop.edges.length > 0);
  loops.length = 0;
  loops.push(...nonEmptyLoops);
  if (duplicateEdgesRemoved > 0) {
    logger.debug(
      'build-faction-loops.ts',
      `Removed ${duplicateEdgesRemoved} duplicate edge(s) from ${faction} loops`,
    );
  }

// calculate loops length, left/right affiliations, orientation, and sort
  loops.forEach((loop) => {
    loop.length = loop.edges
      .map((edge) => edge.length)
      .reduce((sum, current) => sum + current, 0);

    loop.edges.forEach((edge, edgeIndex) => {
      // Mark the leftmost-topmost edge as the loop's minimum edge (the
      // point with the smallest x, breaking ties by smallest y).
      if (loop.minEdgeIdx < 0 || edge.node2.x < loop.edges[loop.minEdgeIdx].node2.x) {
        loop.minEdgeIdx = edgeIndex;
      } else if (
        edge.node2.x === loop.edges[loop.minEdgeIdx].node2.x &&
        edge.node2.y < loop.edges[loop.minEdgeIdx].node2.y
      ) {
        loop.minEdgeIdx = edgeIndex;
      }
      // find the affiliation to the left and right of the current edge
      // IMPORTANT: Use BOTH vertices to determine left/right. Edges may have been
      // reversed during merging (node1/node2 swapped) but vertex1Idx/vertex2Idx
      // are NOT swapped. Testing only vertex1Idx gives wrong results for reversed edges.
      const vertex1 = vertices[edge.vertex1Idx];
      const vertex2 = vertices[edge.vertex2Idx];
      const vertex1IsLeft = pointIsLeftOfLine(vertex1, edge.node1, edge.node2);
      const vertex2IsLeft = pointIsLeftOfLine(vertex2, edge.node1, edge.node2);

      // The two Delaunay vertices must be on opposite sides of the edge
      if (vertex1IsLeft === vertex2IsLeft) {
        // Edge coordinates have been mutated by relaxBorderSection/pruneShortEdges
        // away from their original Voronoi positions, so the left/right test is
        // unreliable. Fall back to a best-guess default (aff1=left, aff2=right)
        // rather than using the degenerate result. ensureEdgeLoopClockwiseOrder
        // will correct the orientation for closed loops.
        logger.debug(
          'build-faction-loops.ts',
          'Both vertices on same side of edge - using fallback affiliation assignment',
          edge.id,
          edge.affiliation1,
          edge.affiliation2,
        );
        edge.leftAffiliation = edge.affiliation1;
        edge.rightAffiliation = edge.affiliation2;
      } else if (vertex1IsLeft) {
        // vertex1 is on left -> affiliation1 is left, affiliation2 is right
        edge.leftAffiliation = edge.affiliation1;
        edge.rightAffiliation = edge.affiliation2;
      } else {
        // vertex2 is on left -> affiliation2 is left, affiliation1 is right
        edge.leftAffiliation = edge.affiliation2;
        edge.rightAffiliation = edge.affiliation1;
      }
    });

    // Only ensure clockwise order and set inner/outer affiliation for CLOSED loops.
    // Stranded open borders (isLoop === false) have no "inside"/"outside" — they are
    // border lines between two factions. Calling ensureEdgeLoopClockwiseOrder
    // on them incorrectly wraps the edge index and assigns bogus inner/outer
    // affiliations, which causes rendering artifacts like disputed patterns over
    // A loop built by buildFactionLoops("LC", ...) is LC's border — the inside
    // is always LC. We assign innerAffiliation unconditionally rather than
    // computing from rightAffiliation majority, because after simplification
    // the per-edge pointIsLeftOfLine test can give wrong results, and the
    // section assembly direction is arbitrary.
    //
    // For closed loops, we ALSO fix the winding direction so that the CW
    // orientation is around the correct territory (not a neighboring faction's).
    // This matters for edge left/right affiliation assignment in the renderer.
    if (loop.isLoop) {
      // Ensure clockwise winding (the convention for closed loops)
      ensureEdgeLoopClockwiseOrder(loop);

      // Determine the true inner affiliation by counting Delaunay vertices
      // (actual system positions) inside the polygon. This catches loops that
      // were assembled in the wrong winding direction.
      function countVerticesInside(pts: Array<{x: number; y: number}>) {
        const counts = new Map<string, number>();
        for (const v of vertices) {
          const vAff = extractBorderStateAffiliation(v.affiliation, undefined, undefined, 1, true);
          if (!vAff || vAff === EMPTY_FACTION) continue;
          if (polygonContains(pts, { x: v.x, y: v.y })) {
            counts.set(vAff, (counts.get(vAff) ?? 0) + 1);
          }
        }
        return counts;
      }

      let loopPoints = loop.edges.map((e) => e.node1);
      let insideCounts = countVerticesInside(loopPoints);
      let bestInsideAff: string | undefined;
      let bestInsideCount = 0;
      for (const [aff, count] of insideCounts) {
        if (count > bestInsideCount) {
          bestInsideAff = aff;
          bestInsideCount = count;
        }
      }

      if (bestInsideAff && bestInsideAff !== faction) {
        logger.debug(
          'build-faction-loops.ts',
          `Loop for "${faction}" encloses "${bestInsideAff}" (${bestInsideCount} vertices). Reversing and re-orienting.`,
          loop.id,
        );
        reverseEdgeLoop(loop);
        ensureEdgeLoopClockwiseOrder(loop);

        // Verify after reversal
        loopPoints = loop.edges.map((e) => e.node1);
        insideCounts = countVerticesInside(loopPoints);
        let newBestAff: string | undefined;
        let newBestCount = 0;
        for (const [aff, count] of insideCounts) {
          if (count > newBestCount) {
            newBestAff = aff;
            newBestCount = count;
          }
        }
        if (newBestAff && newBestAff !== faction) {
          logger.debug(
            'build-faction-loops.ts',
            `Still encloses "${newBestAff}" after reversal. Reversing again.`,
            loop.id,
          );
          reverseEdgeLoop(loop);
          ensureEdgeLoopClockwiseOrder(loop);
        }
      }
    }

    // The loop was assembled from this faction's own sections, so membership
    // stays with the builder faction — but if the orientation-derived owner
    // disagrees, the loop likely encloses foreign territory (inside-out
    // assembly), which previously surfaced as mis-colored pockets with no
    // diagnostic. Keep the force (render membership must not flap), but warn.
    const computedOwner = loop.innerAffiliation;
    loop.innerAffiliation = faction;
    if (loop.isLoop && computedOwner && computedOwner.toUpperCase() !== faction.toUpperCase()) {
      logger.warn(
        'build-faction-loops.ts',
        `Loop "${loop.id}" built for "${faction}" has computed owner "${computedOwner}" — forcing to builder faction; probable inside-out assembly enclosing foreign systems`,
      );
    }
  });

   // Remove redundant enclaves: a smaller closed loop of the SAME faction that sits
  // entirely inside a larger loop produces a duplicate fill (a region painted twice)
  // and the "extra loops" artifact. Keep only the outer loop.
  //
  // IMPORTANT: We compute the loop's "owner faction" from its edges' affiliations
  // (the faction on the INSIDE of the loop, i.e., the right-side affiliation for a
  // clockwise loop) rather than trusting `innerAffiliation` alone. This prevents
  // the case where a wrong `innerAffiliation` (due to orientation issues) causes
  // the wrong loop to be removed — e.g., an MoC enclave inside FWL being deleted
  // because its `innerAffiliation` was incorrectly set to FWL.
  const closedLoops = loops.filter((l) => l.isLoop);

  /**
   * Computes the owner faction of a closed loop from the rightAffiliation
   * votes across its edges. Every closed loop here runs through
   * `ensureEdgeLoopClockwiseOrder` first, so the loop is clockwise and
   * rightAffiliation is the faction on the INSIDE (the territory owner).
   *
   * NEVER falls back to `innerAffiliation`: that field is force-set to the
   * builder faction for every loop (see the `loop.innerAffiliation = faction`
   * assignment above), so a fallback would claim the builder owns loops whose
   * interior actually belongs to someone else — and the enclave test would then
   * delete a genuine enclave as "redundant". When no edge carries a vote the
   * owner is genuinely unknown, so `undefined` is returned: the owner
   * comparison then only matches against another vote-less loop (geometry
   * decides), never against a loop with a known owner.
   */
  const computeOwnerFaction = (loop: BorderSection): string | undefined => {
    const counts = new Map<string, number>();
    for (const edge of loop.edges) {
      const aff = edge.rightAffiliation;
      if (aff && aff !== '') {
        counts.set(aff, (counts.get(aff) ?? 0) + 1);
      }
    }
    // Deterministic owner pick: highest vote count wins, ties broken by
    // faction key (ascending) so resolution never depends on map iteration order.
    const sorted = [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    );
    const bestEntry = sorted[0];
    return bestEntry && bestEntry[1] > 0 ? bestEntry[0] : undefined;
  };

  const isEnclave = (inner: BorderSection, outer: BorderSection): boolean => {
    if (inner === outer) return false;
    // Compare OWNER faction (computed from edge affiliations), not innerAffiliation,
    // because innerAffiliation may be wrong if the loop orientation was mis-detected.
    const innerOwner = computeOwnerFaction(inner);
    const outerOwner = computeOwnerFaction(outer);
    if (innerOwner !== outerOwner) return false;
    if ((inner.length ?? 0) >= (outer.length ?? 0)) return false;
    // Test the centroid of the inner loop against the outer polygon.
    const cx = inner.edges.reduce((s, e) => s + e.node1.x, 0) / inner.edges.length;
    const cy = inner.edges.reduce((s, e) => s + e.node1.y, 0) / inner.edges.length;
    return polygonContains(outer.edges.map((e) => e.node1), { x: cx, y: cy });
  };
  // Near-duplicate suppression: a loop whose edge-id set is almost entirely
  // (>= the near-duplicate threshold) contained in a LONGER loop's set is a
  // duplicate rendering of the same border (e.g. nested twins whose noisy
  // owners defeated the enclave test above) and would double-paint strokes and
  // fills. This is purely geometric, so owner miscomputation cannot defeat it.
  // The threshold is tunable via `nearDuplicateThreshold` (default
  // NEAR_DUPLICATE_THRESHOLD = 90%, not 100%) so segmentation drift is
  // tolerated; legitimately adjacent territories share only a few segments and
  // stay below it.
  const idSets = new Map<BorderSection, Set<string>>(
    closedLoops.map((l) => [l, new Set(l.edges.map((e) => e.id).filter(Boolean))]),
  );
  const isNearDuplicate = (inner: BorderSection, outer: BorderSection): boolean => {
    if (inner === outer) return false;
    const innerIds = idSets.get(inner);
    const outerIds = idSets.get(outer);
    if (!innerIds || !outerIds || innerIds.size === 0) return false;
    if ((inner.length ?? 0) >= (outer.length ?? 0)) return false;
    let shared = 0;
    for (const id of innerIds) {
      if (outerIds.has(id)) shared++;
    }
    return shared / innerIds.size >= nearDuplicateThreshold;
  };
  const keptLoops = loops.filter((loop) => {
    if (!loop.isLoop) return true;
    const enclosed = closedLoops.some(
      (other) => isEnclave(loop, other) && !isEnclave(other, loop),
    );
    if (enclosed) {
      logger.debug('build-faction-loops.ts', 'Removing redundant enclave loop', loop.id, loop.innerAffiliation);
      return false;
    }
    const duplicated = closedLoops.some((other) => isNearDuplicate(loop, other));
    if (duplicated) {
      logger.debug(
        'build-faction-loops.ts',
        `Removing near-duplicate loop (>=${(nearDuplicateThreshold * 100).toFixed(0)}% shared edges)`,
        loop.id,
        loop.innerAffiliation,
      );
      return false;
    }
    return true;
  });

  keptLoops.sort((a, b) => (b.length ?? 0) - (a.length ?? 0));
  return keptLoops;
}
