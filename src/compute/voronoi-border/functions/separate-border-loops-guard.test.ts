import { expect, describe, it } from 'vitest';
import { separateBorderLoops } from './separate-border-loops';
import { BorderDelaunayVertex, BorderEdgeLoop } from '../types';
import { polygonContains } from '../../../common';

function node(id: string, x: number, y: number) {
  return {
    id,
    x,
    y,
    vertex1Idx: 0,
    vertex2Idx: 0,
    vertex3Idx: 0,
    neighborNodeIndices: [] as Array<number>,
    borderAffiliations: {},
  };
}

function edge(id: string, a: ReturnType<typeof node>, b: ReturnType<typeof node>) {
  return {
    id,
    node1: a,
    node2: b,
    vertex1Idx: 0,
    vertex2Idx: 0,
    affiliation1: 'DC',
    affiliation2: 'LC',
    leftAffiliation: 'LC',
    rightAffiliation: 'DC',
    length: 10,
    closeness: 99,
  };
}

describe('separate-border-loops neighbor-safety guard', () => {
  it('lets a node 0.12 from a foreign vertex move (pre-check uses the same squared margin)', () => {
    // CW square (map frame, y-up): junctions are DISTINCT node objects, as in
    // real loops before weldLoopJoints runs.
    const n0a = node('n0', 0, 0);
    const n1a = node('n1', 0, 10);
    const n1b = node('n1', 0, 10);
    const n2a = node('n2', 10, 10);
    const n2b = node('n2', 10, 10);
    const n3a = node('n3', 10, 0);
    const n3b = node('n3', 10, 0);
    const n0b = node('n0', 0, 0);
    const loop = {
      edges: [
        edge('e0', n0a, n1a),
        edge('e1', n1b, n2a),
        edge('e2', n2b, n3a),
        edge('e3', n3b, n0b),
      ],
      minEdgeIdx: 0,
      innerAffiliation: 'DC',
    } as unknown as BorderEdgeLoop;

    // Foreign vertex 0.12 from e0's node2 — inside the OLD inflated pre-check
    // radius (0.08 + 0.1 = 0.18), which froze the node even though the move
    // takes it AWAY from the vertex.
    const vertices = [
      { x: 0, y: 10.12, affiliation: 'LC', adjacentTriIndices: [] },
    ] as Array<BorderDelaunayVertex>;

    const loops = { DC: [loop] };
    separateBorderLoops(loops, vertices, 0.3);

    // No systems vote -> innerAffiliation -> inward pull; scaleVector scales
    // the corner bisector to length `tension` (0.3), split evenly per axis:
    // node moves to (0.3/sqrt(2), 10 - 0.3/sqrt(2)).
    const step = 0.3 / Math.SQRT2;
    const n1aAfter = loops.DC[0].edges[0].node2;
    expect(n1aAfter.x).toBeCloseTo(step, 6);
    expect(n1aAfter.y).toBeCloseTo(10 - step, 6);
    // Its junction twin rides along.
    const n1bAfter = loops.DC[0].edges[1].node1;
    expect(n1bAfter.x).toBeCloseTo(step, 6);
    expect(n1bAfter.y).toBeCloseTo(10 - step, 6);
  });
});

describe('separate-border-loops winding-number backup', () => {
  it('votes a system the ray cast misses so the loop pulls away from it', () => {
    // The SAME square traced TWICE (8 edges): a ray from the centre crosses
    // the boundary an even number of times, so polygonContains reports
    // "outside", while the winding number is non-zero (both traces wind the
    // same way). This mirrors self-touching contours from assembly/simplify
    // drift.
    const n0a = node('n0', 0, 0);
    const n1a = node('n1', 0, 10);
    const n1b = node('n1', 0, 10);
    const n2a = node('n2', 10, 10);
    const n2b = node('n2', 10, 10);
    const n3a = node('n3', 10, 0);
    const n3b = node('n3', 10, 0);
    const n4a = node('n4', 0, 0);
    const n4b = node('n4', 0, 0);
    const n5a = node('n5', 0, 10);
    const n5b = node('n5', 0, 10);
    const n6a = node('n6', 10, 10);
    const n6b = node('n6', 10, 10);
    const n7a = node('n7', 10, 0);
    const n7b = node('n7', 10, 0);
    const n0b = node('n0', 0, 0);
    const loop = {
      edges: [
        edge('e0', n0a, n1a),
        edge('e1', n1b, n2a),
        edge('e2', n2b, n3a),
        edge('e3', n3b, n4a),
        edge('e4', n4b, n5a),
        edge('e5', n5b, n6a),
        edge('e6', n6b, n7a),
        edge('e7', n7b, n0b),
      ],
      minEdgeIdx: 0,
      innerAffiliation: 'DC',
    } as unknown as BorderEdgeLoop;

    const pts = loop.edges.map((e) => e.node1);
    // The primary test genuinely misses the enclosed system...
    expect(polygonContains(pts, { x: 5, y: 5 })).toBe(false);

    const vertices = [
      { x: 5, y: 5, affiliation: 'LC', adjacentTriIndices: [] },
    ] as Array<BorderDelaunayVertex>;

    const loops = { DC: [loop] };
    separateBorderLoops(loops, vertices, 0.3);

    // Winding backup rescues the vote -> owner LC (foreign to DC) ->
    // negative tension -> OUTWARD pull: (0,10) moves to
    // (-0.3/sqrt(2), 10 + 0.3/sqrt(2)), away from the enclosed system.
    // Without the backup the vote would come up empty and fall back to
    // innerAffiliation (inward pull).
    const step = 0.3 / Math.SQRT2;
    const n1aAfter = loops.DC[0].edges[0].node2;
    expect(n1aAfter.x).toBeCloseTo(-step, 6);
    expect(n1aAfter.y).toBeCloseTo(10 + step, 6);
  });
});

describe('separate-border-loops frontier convexity', () => {
  it('pushes border away from frontier own-faction system (convex boundary)', () => {
    // DC rectangle territory with a DC system near the bottom edge (frontier).
    // The system is at (5, 0.5), very close to the bottom edge.
    const n0a = node('n0', 0, 0);
    const n1a = node('n1', 0, 10);
    const n1b = node('n1', 0, 10);
    const n2a = node('n2', 10, 10);
    const n2b = node('n2', 10, 10);
    const n3a = node('n3', 10, 0);
    const n3b = node('n3', 10, 0);
    const n0b = node('n0', 0, 0);
    const loop = {
      edges: [
        edge('e0', n0a, n1a),
        edge('e1', n1b, n2a),
        edge('e2', n2b, n3a),
        edge('e3', n3b, n0b),
      ],
      minEdgeIdx: 0,
      innerAffiliation: 'DC',
    } as unknown as BorderEdgeLoop;

    // DC system at (5, 0.5) — frontier system near bottom edge (within 1.0 proximity radius)
    const vertices = [
      { x: 5, y: 0.5, affiliation: 'DC', adjacentTriIndices: [] },
    ] as Array<BorderDelaunayVertex>;

    const loops = { DC: [loop] };
    separateBorderLoops(loops, vertices, 0.3);

    // Bottom edge (e3): DC system at (5, 0.5) is within 1.0 units → negative
    // tension pushes node2 (n0b at 0,0) AWAY from interior (left+down)
    const n0bAfter = loops.DC[0].edges[3].node2;
    expect(n0bAfter.x).toBeLessThan(0);
    expect(n0bAfter.y).toBeLessThan(0);
    // Right edge (e2): system is 5.0 units away → no modulation, positive
    // tension pulls node2 (n3a at 10,0) TOWARD interior (left+up)
    const n3aAfter = loops.DC[0].edges[2].node2;
    expect(n3aAfter.x).toBeLessThan(10);
    expect(n3aAfter.y).toBeGreaterThan(0);
    // DC system remains inside the expanded territory
    const pts = loops.DC[0].edges.map((e) => e.node1);
    expect(polygonContains(pts, { x: 5, y: 0.5 })).toBe(true);
  });

  it('does not affect deep interior systems (no nearby border edge)', () => {
    const n0a = node('n0', 0, 0);
    const n1a = node('n1', 0, 10);
    const n1b = node('n1', 0, 10);
    const n2a = node('n2', 10, 10);
    const n2b = node('n2', 10, 10);
    const n3a = node('n3', 10, 0);
    const n3b = node('n3', 10, 0);
    const n0b = node('n0', 0, 0);
    const loop = {
      edges: [
        edge('e0', n0a, n1a),
        edge('e1', n1b, n2a),
        edge('e2', n2b, n3a),
        edge('e3', n3b, n0b),
      ],
      minEdgeIdx: 0,
      innerAffiliation: 'DC',
    } as unknown as BorderEdgeLoop;

    // DC system at (5, 5) — deep interior, no border edge within 1.0 units
    const vertices = [
      { x: 5, y: 5, affiliation: 'DC', adjacentTriIndices: [] },
    ] as Array<BorderDelaunayVertex>;

    const loops = { DC: [loop] };
    separateBorderLoops(loops, vertices, 0.3);

    // No edge near the system: tension unchanged (positive) → nodes move toward interior
    const step = 0.3 / Math.SQRT2;
    const n1aAfter = loops.DC[0].edges[0].node2;
    expect(n1aAfter.x).toBeCloseTo(step, 6);
    expect(n1aAfter.y).toBeCloseTo(10 - step, 6);
  });
});
