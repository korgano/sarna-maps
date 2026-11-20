import { expect, describe, it } from 'vitest';
import { weldLoopJoints } from './separate-border-loops';
import { BorderEdgeLoop } from '../types';

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

describe('weldLoopJoints', () => {
  it('reunites cracked junctions between shared and unshared segments', () => {
    // Simulates post-snap state: edge1 (shared, snapped to centroid) ends at
    // (10, 0) while edge2 (unshared, unmoved) starts at (10.4, 0.2).
    const n1 = node('n1', 0, 0);
    const n2a = node('n2', 10, 0);
    const n2b = node('n2', 10.4, 0.2);
    const n3 = node('n3', 10, 10);
    const loop = {
      edges: [edge('s1', n1, n2a), edge('u1', n2b, n3)],
      minEdgeIdx: 0,
      innerAffiliation: 'DC',
    } as unknown as BorderEdgeLoop;

    weldLoopJoints({ DC: [loop] });

    expect(n2a.x).toBeCloseTo(10.2, 6);
    expect(n2b.x).toBeCloseTo(10.2, 6);
    expect(n2a.y).toBeCloseTo(0.1, 6);
    expect(n2b.y).toBeCloseTo(0.1, 6);
  });

  it('welds the closing junction of geometrically closed loops', () => {
    const n1 = node('n1', 0, 0);
    const n2 = node('n2', 10, 0);
    const n1close = node('n1', 0.3, 0.1);
    const loop = {
      edges: [edge('s1', n1, n2), edge('s2', n2, n1close)],
      minEdgeIdx: 0,
      innerAffiliation: 'DC',
    } as unknown as BorderEdgeLoop;

    weldLoopJoints({ DC: [loop] });

    expect(n1close.x).toBeCloseTo(0.15, 9);
    expect(n1close.y).toBeCloseTo(0.05, 9);
    expect(n1.x).toBeCloseTo(0.15, 9);
    expect(n1.y).toBeCloseTo(0.05, 9);
  });

  it('leaves genuinely open chains open at their free ends', () => {
    const n1 = node('a1', 0, 0);
    const n2 = node('a2', 10, 0);
    const n3 = node('b9', 50, 50);
    const loop = {
      edges: [edge('s1', n1, n2), edge('u1', n2, n3)],
      minEdgeIdx: 0,
      innerAffiliation: 'DC',
    } as unknown as BorderEdgeLoop;

    weldLoopJoints({ DC: [loop] });

    // Free ends untouched; interior junction welded (n2 shared object here).
    expect(n1.x).toEqual(0);
    expect(n3.x).toEqual(50);
  });
});
