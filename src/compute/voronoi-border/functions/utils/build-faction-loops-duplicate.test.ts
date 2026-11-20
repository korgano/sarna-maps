import { expect, describe, it } from 'vitest';
import { buildFactionLoops, NEAR_DUPLICATE_THRESHOLD } from './build-faction-loops';
import { BorderSection } from '../../types';

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

function edge(id: string, a: ReturnType<typeof node>, b: ReturnType<typeof node>, aff1: string, aff2: string, len: number) {
  return {
    id,
    node1: a,
    node2: b,
    vertex1Idx: 0,
    vertex2Idx: 0,
    affiliation1: aff1,
    affiliation2: aff2,
    leftAffiliation: '',
    rightAffiliation: '',
    length: len,
    closeness: 99,
  };
}

// Closed triangular section. Both sections touch FWL so both enter FWL's
// loop set; per-edge ownership falls back to affiliation2, yielding DIFFERENT
// computed owners ('Y' vs 'Q') to simulate post-simplify owner noise that
// defeats the enclave test.
function triangleSection(
  id: string, aff1: string, aff2: string, edgeLen: number,
  p1: [number, number], p2: [number, number], p3: [number, number], edgeIds: string[],
): BorderSection {
  const a = node(`${id}-a`, p1[0], p1[1]);
  const b = node(`${id}-b`, p2[0], p2[1]);
  const c = node(`${id}-c`, p3[0], p3[1]);
  return {
    id,
    edges: [edge(edgeIds[0], a, b, aff1, aff2, edgeLen), edge(edgeIds[1], b, c, aff1, aff2, edgeLen), edge(edgeIds[2], c, a, aff1, aff2, edgeLen)],
    isLoop: true,
    affiliation1: aff1,
    affiliation2: aff2,
    node1: a,
    node2: a,
    length: -1,
    minEdgeIdx: -1,
  } as unknown as BorderSection;
}

describe('buildFactionLoops near-duplicate suppression', () => {
  it('drops the smaller twin when owners disagree (noisy) but edge sets overlap', () => {
    const small = triangleSection('small', 'FWL', 'Y', 1, [4, 4], [6, 4], [5, 6], ['e1', 'e2', 'e3']);
    // big is a quad sharing all three of small's edge ids plus one extra.
    const q1 = node('q1', 0, 0);
    const q2 = node('q2', 10, 0);
    const q3 = node('q3', 10, 10);
    const q4 = node('q4', 0, 10);
    const bigQuad: BorderSection = {
      id: 'big',
      edges: [
        edge('e1', q1, q2, 'FWL', 'Q', 100),
        edge('e2', q2, q3, 'FWL', 'Q', 100),
        edge('e3', q3, q4, 'FWL', 'Q', 100),
        edge('e4', q4, q1, 'FWL', 'Q', 100),
      ],
      isLoop: true,
      affiliation1: 'FWL',
      affiliation2: 'Q',
      node1: q1,
      node2: q1,
      length: -1,
      minEdgeIdx: -1,
    } as unknown as BorderSection;

    const vertices = [
      { id: 'v0', x: -100, y: -100, affiliation: '', adjacentTriIndices: [] as Array<number> },
    ] as never;

    const loops = buildFactionLoops('FWL', [small, bigQuad], vertices as never);

    // small: 3/3 ids shared (100%) + shorter → dropped despite owner mismatch.
    expect(loops.length).toEqual(1);
    expect(loops[0].id).toEqual('big');
  });

  it('self-closes a stranded chain whose ends nearly meet (FWL class)', () => {
    // One open chain of FWL-touching sections with a 0.35-unit end gap
    // (simplify drift, cf. MERGE_EPSILON 0.5): must close, not strand.
    const a = node('a', 0, 0);
    const b = node('b', 10, 0);
    const c = node('c', 10, 10);
    const d = node('d', 0.3, 0.2);
    const chain: BorderSection = {
      id: 'chain',
      edges: [
        edge('e1', a, b, 'FWL', 'DC', 10),
        edge('e2', b, c, 'FWL', 'DC', 10),
        edge('e3', c, d, 'FWL', 'DC', 10),
      ],
      isLoop: false,
      affiliation1: 'FWL',
      affiliation2: 'DC',
      node1: a,
      node2: d,
      length: -1,
      minEdgeIdx: -1,
    } as unknown as BorderSection;
    const vertices = [
      { id: 'v0', x: -100, y: -100, affiliation: '', adjacentTriIndices: [] as Array<number> },
    ] as never;

    const loops = buildFactionLoops('FWL', [chain], vertices as never);

    expect(loops.length).toEqual(1);
    expect(loops[0].edges.length).toEqual(4); // + synthetic chord
    // Orientation may rotate the array, so locate the chord by id.
    expect(loops[0].edges.some((e) => e.id === 'close-chain')).toEqual(true);
  });

  it('leaves genuinely open chains (far-apart ends) stranded', () => {
    const a = node('a', 0, 0);
    const b = node('b', 10, 0);
    const c = node('c', 50, 50);
    const chain: BorderSection = {
      id: 'chain',
      edges: [
        edge('e1', a, b, 'FWL', 'DC', 10),
        edge('e2', b, c, 'FWL', 'DC', 60),
      ],
      isLoop: false,
      affiliation1: 'FWL',
      affiliation2: 'DC',
      node1: a,
      node2: c,
      length: -1,
      minEdgeIdx: -1,
    } as unknown as BorderSection;
    const vertices = [
      { id: 'v0', x: -100, y: -100, affiliation: '', adjacentTriIndices: [] as Array<number> },
    ] as never;

    const loops = buildFactionLoops('FWL', [chain], vertices as never);

    expect(loops.length).toEqual(1);
    expect(loops[0].edges.length).toEqual(2); // no chord appended
  });

  it('keeps legitimately adjacent territories sharing a single segment', () => {
    const left = triangleSection('left', 'FWL', 'Y', 10, [0, 0], [10, 0], [5, 8], ['s1', 's2', 'shared']);
    const right = triangleSection('right', 'FWL', 'Q', 10, [10, 0], [20, 0], [15, 8], ['t1', 't2', 'shared']);
    const vertices = [
      { id: 'v0', x: -100, y: -100, affiliation: '', adjacentTriIndices: [] as Array<number> },
    ] as never;

    const loops = buildFactionLoops('FWL', [left, right], vertices as never);

    // 1/3 shared (33%) — below threshold, and centroids outside each other.
    expect(loops.length).toEqual(2);
  });

  it('honours a custom near-duplicate threshold (default stays 90%)', () => {
    expect(NEAR_DUPLICATE_THRESHOLD).toEqual(0.9);

    // small is wound CCW, so clockwise ordering reverses it and its owner vote
    // becomes affiliation1 ('FWL'); big is wound CW (no reversal), so its vote
    // stays affiliation2 ('Q'). The owner mismatch defeats the enclave test —
    // only the geometric near-duplicate test can drop small.
    const small = triangleSection('small', 'FWL', 'Y', 1, [4, 4], [6, 4], [5, 6], ['e1', 'e2', 'e3']);
    // big shares only 2 of small's 3 edge ids (66.7%) — below the 90% default,
    // above an explicit 60%.
    const q1 = node('q1', 0, 0);
    const q2 = node('q2', 10, 0);
    const q3 = node('q3', 10, 10);
    const q4 = node('q4', 0, 10);
    const bigQuad: BorderSection = {
      id: 'big',
      edges: [
        edge('e1', q1, q4, 'FWL', 'Q', 100),
        edge('e2', q4, q3, 'FWL', 'Q', 100),
        edge('x1', q3, q2, 'FWL', 'Q', 100),
        edge('x2', q2, q1, 'FWL', 'Q', 100),
      ],
      isLoop: true,
      affiliation1: 'FWL',
      affiliation2: 'Q',
      node1: q1,
      node2: q1,
      length: -1,
      minEdgeIdx: -1,
    } as unknown as BorderSection;
    const vertices = [
      { id: 'v0', x: -100, y: -100, affiliation: '', adjacentTriIndices: [] as Array<number> },
    ] as never;

    // Default threshold (90%): 66.7% shared stays below it → both kept.
    const withDefault = buildFactionLoops('FWL', [small, bigQuad], vertices as never);
    expect(withDefault.length).toEqual(2);

    // Tunable override: 60% → the shorter twin is a near-duplicate and drops.
    const withOverride = buildFactionLoops('FWL', [small, bigQuad], vertices as never, 0.6);
    expect(withOverride.length).toEqual(1);
    expect(withOverride[0].id).toEqual('big');
  });

  it('never falls back to innerAffiliation when rightAffiliation votes are missing', () => {
    // Outer is wound CW, so clockwise ordering leaves it unreversed and its
    // edges keep rightAffiliation = affiliation2 = '' → zero votes → owner
    // unknown. innerAffiliation is force-set to the builder faction ('FWL')
    // for both loops, so an innerAffiliation fallback would report outer owner
    // 'FWL', match the inner loop's voted owner 'FWL', and wrongly delete the
    // inner loop as a "redundant enclave".
    const outer = triangleSection('outer', 'FWL', '', 100, [0, 0], [5, 10], [10, 0], ['o1', 'o2', 'o3']);
    const inner = triangleSection('inner', 'FWL', 'FWL', 1, [4, 4], [6, 4], [5, 6], ['i1', 'i2', 'i3']);
    const vertices = [
      { id: 'v0', x: -100, y: -100, affiliation: '', adjacentTriIndices: [] as Array<number> },
    ] as never;

    const loops = buildFactionLoops('FWL', [outer, inner], vertices as never);

    expect(loops.length).toEqual(2);
  });
});
