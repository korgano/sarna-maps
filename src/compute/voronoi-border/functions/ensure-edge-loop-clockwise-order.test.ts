import { expect, describe, it } from 'vitest';
import { ensureEdgeLoopClockwiseOrder } from './ensure-edge-loop-clockwise-order';
import { signedAreaOfPolygon } from '../../../common/math-2d/signed-area-of-polygon';
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
    affiliation1: 'X',
    affiliation2: 'O',
    // Interior of the square is on the LEFT while wound CCW, on the RIGHT
    // once corrected to CW. Start CCW: left=X (faction), right=O (outside).
    leftAffiliation: 'X',
    rightAffiliation: 'O',
    length: 10,
    closeness: 99,
  };
}

/**
 * Square (0,0)->(10,0)->(10,10)->(0,10) in MAP coordinates (y increases
 * upward, as authored: render negates y for SVG). This traversal is
 * counter-clockwise: interior on the left.
 */
function ccwSquare(): BorderEdgeLoop {
  const n1 = node('n1', 0, 0);
  const n2 = node('n2', 10, 0);
  const n3 = node('n3', 10, 10);
  const n4 = node('n4', 0, 10);
  return {
    edges: [edge('e1', n1, n2), edge('e2', n2, n3), edge('e3', n3, n4), edge('e4', n4, n1)],
    minEdgeIdx: 0,
  } as unknown as BorderEdgeLoop;
}

describe('signedAreaOfPolygon frame check', () => {
  it('is negative for CCW traversal in map (y-up) coordinates', () => {
    // Guard for the negated-shoelace formula: standard shoelace is +100 here.
    const pts = [node('a', 0, 0), node('b', 10, 0), node('c', 10, 10), node('d', 0, 10)];
    expect(signedAreaOfPolygon(pts)).toBeLessThan(0);
  });
});

describe('ensureEdgeLoopClockwiseOrder', () => {
  it('reverses CCW loops to CW and moves the faction to the right side', () => {
    const loop = ccwSquare();
    ensureEdgeLoopClockwiseOrder(loop);
    // Interior (faction X) must now be on the right of every edge.
    for (const e of loop.edges) {
      expect((e as { rightAffiliation?: string }).rightAffiliation).toEqual('X');
    }
    expect(loop.innerAffiliation).toEqual('X');
    expect(loop.outerAffiliation).toEqual('O');
  });

  it('leaves already-CW loops untouched', () => {
    const loop = ccwSquare();
    ensureEdgeLoopClockwiseOrder(loop);
    const firstNodeId = (loop.edges[0].node1 as { id: string }).id;
    ensureEdgeLoopClockwiseOrder(loop);
    // Second call must be a no-op: orientation already CW.
    expect((loop.edges[0].node1 as { id: string }).id).toEqual(firstNodeId);
    expect(loop.innerAffiliation).toEqual('X');
  });
});
