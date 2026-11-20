import { expect, describe, it } from 'vitest';
import { Point2d } from '../../../../common';
import { VoronoiBorderEdge } from '../types';
import {
  buildCanonicalEdgeControls,
  applyCanonicalEdgeControls,
  CanonicalEdgeControls,
} from './generate-edge-control-points-for-section';
import { BorderEdgeLoop } from '../../../compute';

function node(id: string, x: number, y: number): VoronoiBorderEdge['node1'] {
  return { id, x, y, vertex1Idx: 0, vertex2Idx: 0, vertex3Idx: 0, neighborNodeIndices: [], borderAffiliations: {} };
}

function edge(
  id: string,
  n1: ReturnType<typeof node>,
  n2: ReturnType<typeof node>,
): VoronoiBorderEdge {
  return {
    id,
    node1: n1,
    node2: n2,
    vertex1Idx: 0,
    vertex2Idx: 0,
    affiliation1: 'FACTION',
    affiliation2: 'OTHER',
    leftAffiliation: 'OTHER',
    rightAffiliation: 'FACTION',
    length: 10,
    closeness: 99,
  } as VoronoiBorderEdge;
}

function loopFor(owner: string, edges: Array<VoronoiBorderEdge>): BorderEdgeLoop {
  return {
    edges,
    minEdgeIdx: 0,
    innerAffiliation: owner,
    outerAffiliation: 'OTHER',
  } as unknown as BorderEdgeLoop;
}

describe('generate-edge-control-points (edge-centric canonical handles)', () => {
  it('two reversed clones of the same edge with different loop contexts get identical handles', () => {
    // Shared edge "1"(0,0) -> "2"(10,0). At node "2" two faction loops diverge
    // onto different third borders: straight to "3"(20,0), sharp to "4"(10,10).
    // Edge ids are derived from node indices, so node .id must equal the edge-id
    // parts (real code: node.id = vertexIdx/3, edgeId = [i,j].join('-')).
    const a = node('1', 0, 0);
    const b = node('2', 10, 0);
    const c1 = node('3', 20, 0); // straight continuation (dot = 1)
    const c2 = node('4', 10, 10); // sharp turn (dot = 0)

    const shared = edge('1-2', a, b);
    const contStraight = edge('2-3', b, c1);
    const contSharp = edge('2-4', b, c2);

    const edgeMap: Record<string, VoronoiBorderEdge> = {
      '1-2': shared,
      '2-3': contStraight,
      '2-4': contSharp,
    };

    const controls = buildCanonicalEdgeControls(edgeMap);
    const got = controls.get('1-2');
    expect(got).toBeDefined();

    // At B (node2), straightest continuation C1 wins: triple (A,B,C1),
    // generateBezierControlPoints((0,0),(10,0),(20,0), 0.3) -> c1 = (7,0), c2 = (13,0).
    // At A (node1) there is no other edge -> midpoint (5,0).
    const expected: CanonicalEdgeControls = {
      n1c1: { x: 5, y: 0 },
      n1c2: { x: 5, y: 0 },
      n2c1: { x: 7, y: 0 },
      n2c2: { x: 13, y: 0 },
    };
    expect(got!.n1c1).toEqual(expected.n1c1);
    expect(got!.n1c2).toEqual(expected.n1c2);
    expect(got!.n2c1).toEqual(expected.n2c1);
    expect(got!.n2c2).toEqual(expected.n2c2);

    // Two faction clones of the same edge, each with a *different* loop context
    // (different node objects, different continuation in their own loop).
    const clone1 = edge('1-2', node('1', 0, 0), node('2', 10, 0));
    const clone2 = edge('1-2', node('1', 0, 0), node('2', 10, 0));
    const borderLoops: Record<string, Array<BorderEdgeLoop>> = {
      FACTION1: [loopFor('FACTION1', [clone1])],
      FACTION2: [loopFor('FACTION2', [clone2])],
    };

    applyCanonicalEdgeControls(borderLoops, controls, edgeMap);

    expect(clone1.n1c1).toEqual(clone2.n1c1);
    expect(clone1.n1c2).toEqual(clone2.n1c2);
    expect(clone1.n2c1).toEqual(clone2.n2c1);
    expect(clone1.n2c2).toEqual(clone2.n2c2);
    expect(clone1.n2c1).toEqual(expected.n2c1);
    expect(clone1.n1c2).toEqual(expected.n1c2);
  });

  it('reversed clones of the same edge get handles mapped by node, not field position', () => {
    // Shared edge "1"(0,0)->"2"(10,0); straight continuation at "2" is "3"(20,0).
    // Canonical (orientation of rep): n2c1/n2c2 at node "2" = leave/arrive toward C1.
    const a = node('1', 0, 0);
    const b = node('2', 10, 0);
    const c1 = node('3', 20, 0);
    const shared = edge('1-2', a, b);
    const contStraight = edge('2-3', b, c1);
    const edgeMap: Record<string, VoronoiBorderEdge> = {
      '1-2': shared,
      '2-3': contStraight,
    };
    const controls = buildCanonicalEdgeControls(edgeMap);

    // Faction 1 clone traverses "1"->"2" (same orientation as rep).
    const same = edge('1-2', node('1', 0, 0), node('2', 10, 0));
    // Faction 2 clone traverses "2"->"1" (reversed): node1="2", node2="1".
    const reversed = edge('1-2', node('2', 10, 0), node('1', 0, 0));
    const borderLoops: Record<string, Array<BorderEdgeLoop>> = {
      FACTION1: [loopFor('FACTION1', [same])],
      FACTION2: [loopFor('FACTION2', [reversed])],
    };

    applyCanonicalEdgeControls(borderLoops, controls, edgeMap);

    // same-orientation clone: n2c1 (at "2") = canonical n2c1.
    expect(same.n2c1).toEqual(controls.get('1-2')!.n2c1);
    // reversed clone: its node1 is "2", so n1c2 (leave at "2") = canonical n2c1;
    // its node2 is "1", so n2c1 (arrive at "1") = canonical n1c2.
    expect(reversed.n1c2).toEqual(controls.get('1-2')!.n2c1);
    expect(reversed.n2c1).toEqual(controls.get('1-2')!.n1c2);
    // Both clones paint one identical curve at node "2": same.n2c1 == reversed.n1c2.
    expect(same.n2c1).toEqual(reversed.n1c2);
    // And at node "1": same.n1c2 == reversed.n2c1.
    expect(same.n1c2).toEqual(reversed.n2c1);
  });

  it('interior chains keep the straight-through continuation (dot threshold preserved)', () => {
    // "1"(0,0)->"2"(10,0)->"3"(20,0) straight chain: node "2" has exactly one
    // continuation "3", so both controls at "2" derive from the straight triple.
    const a = node('1', 0, 0);
    const b = node('2', 10, 0);
    const c = node('3', 20, 0);
    const edgeMap: Record<string, VoronoiBorderEdge> = {
      '1-2': edge('1-2', a, b),
      '2-3': edge('2-3', b, c),
    };
    const controls = buildCanonicalEdgeControls(edgeMap);
    const got = controls.get('1-2');
    expect(got).toBeDefined();
    // n2c1 at "2" from triple ("1","2","3"): c1 = (7,0).
    expect(got!.n2c1).toEqual({ x: 7, y: 0 });
    expect(got!.n2c2).toEqual({ x: 13, y: 0 });
  });
});
