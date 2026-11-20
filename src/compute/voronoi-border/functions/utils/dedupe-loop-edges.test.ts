import { expect, describe, it } from 'vitest';
import { dedupeLoopEdges } from './build-faction-loops';
import { BorderSection, VoronoiBorderEdge } from '../../types';

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

type EdgeControls = Pick<VoronoiBorderEdge, 'n1c1' | 'n1c2' | 'n2c1' | 'n2c2'>;

function edge(
  id: string,
  a: ReturnType<typeof node>,
  b: ReturnType<typeof node>,
  controls: EdgeControls = {},
): VoronoiBorderEdge {
  return {
    id,
    node1: a,
    node2: b,
    vertex1Idx: 0,
    vertex2Idx: 0,
    affiliation1: 'DC',
    affiliation2: 'LC',
    leftAffiliation: '',
    rightAffiliation: '',
    length: 10,
    closeness: 99,
    ...controls,
  } as VoronoiBorderEdge;
}

function section(edges: Array<VoronoiBorderEdge>): BorderSection {
  return {
    id: 's',
    edges,
    isLoop: false,
    affiliation1: 'DC',
    affiliation2: 'LC',
    node1: edges[0].node1,
    node2: edges[edges.length - 1].node2,
    length: -1,
    minEdgeIdx: -1,
  } as unknown as BorderSection;
}

describe('dedupeLoopEdges with Bezier control points in the edge key', () => {
  it('removes an exact duplicate (same id, same control points)', () => {
    const controls: EdgeControls = {
      n1c1: { x: 1, y: 1 },
      n1c2: { x: 2, y: 2 },
      n2c1: { x: 3, y: 3 },
      n2c2: { x: 4, y: 4 },
    };
    const first = edge('0-1', node('a', 0, 0), node('b', 10, 0), controls);
    const copy = edge('0-1', node('a', 0, 0), node('b', 10, 0), {
      n1c1: { x: 1, y: 1 },
      n1c2: { x: 2, y: 2 },
      n2c1: { x: 3, y: 3 },
      n2c2: { x: 4, y: 4 },
    });
    const s = section([first, copy]);

    expect(dedupeLoopEdges(s)).toEqual(1);
    expect(s.edges.length).toEqual(1);
    expect(s.edges[0]).toBe(first);
  });

  it('removes a reversed twin (controls mirrored the way swapEdgeNodes mirrors them)', () => {
    // Forward arrangement (n1c1,n1c2,n2c1,n2c2) = 1,2,3,4; the reversed twin
    // carries 4,3,2,1 — same physical curve, must key identically.
    const forward = edge('0-1', node('a', 0, 0), node('b', 10, 0), {
      n1c1: { x: 1, y: 1 },
      n1c2: { x: 2, y: 2 },
      n2c1: { x: 3, y: 3 },
      n2c2: { x: 4, y: 4 },
    });
    const reversed = edge('0-1', node('b', 10, 0), node('a', 0, 0), {
      n1c1: { x: 4, y: 4 },
      n1c2: { x: 3, y: 3 },
      n2c1: { x: 2, y: 2 },
      n2c2: { x: 1, y: 1 },
    });
    const s = section([forward, reversed]);

    expect(dedupeLoopEdges(s)).toEqual(1);
    expect(s.edges.length).toEqual(1);
  });

  it('keeps two distinct segments that share an id but carry different curves', () => {
    // Post-simplify id collision: one id, two physical segments. Dropping one
    // punched a gap in the loop, so control points must participate in the key.
    const first = edge('5-9', node('a', 0, 0), node('b', 10, 0), {
      n1c1: { x: 1, y: 1 },
      n1c2: { x: 2, y: 2 },
      n2c1: { x: 3, y: 3 },
      n2c2: { x: 4, y: 4 },
    });
    const second = edge('5-9', node('c', 20, 20), node('d', 30, 30), {
      n1c1: { x: 21, y: 21 },
      n1c2: { x: 22, y: 22 },
      n2c1: { x: 23, y: 23 },
      n2c2: { x: 24, y: 24 },
    });
    const s = section([first, second]);

    expect(dedupeLoopEdges(s)).toEqual(0);
    expect(s.edges.length).toEqual(2);
  });

  it('applies the same control-point rule to id-less coordinate keys', () => {
    const sameCoords = () => node('x', 7, 7);
    const identical = edge('', sameCoords(), node('y', 8, 8), {
      n1c1: { x: 7, y: 7.5 },
    });
    const identicalCopy = edge('', sameCoords(), node('y', 8, 8), {
      n1c1: { x: 7, y: 7.5 },
    });
    const differentCurve = edge('', sameCoords(), node('y', 8, 8), {
      n1c1: { x: 7.4, y: 7.5 },
    });

    const dedupeable = section([identical, identicalCopy, differentCurve]);
    expect(dedupeLoopEdges(dedupeable)).toEqual(1);
    expect(dedupeable.edges.length).toEqual(2);
  });
});
