import { expect, describe, it } from 'vitest';
import { findPocketHoles, groupBorderLoopsByUpperKey, isLoopClosed } from './normalize-border-loops';
import { BorderEdgeLoop } from '../../../compute';

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

function edge(id: string, a: ReturnType<typeof node>, b: ReturnType<typeof node>, owner: string) {
  return {
    id,
    node1: a,
    node2: b,
    vertex1Idx: 0,
    vertex2Idx: 0,
    affiliation1: owner,
    affiliation2: 'OTHER',
    leftAffiliation: 'OTHER',
    rightAffiliation: owner,
    length: 10,
    closeness: 99,
  };
}

function square(owner: string, x0: number, y0: number, size: number, prefix: string): BorderEdgeLoop {
  const n1 = node(`${prefix}-1`, x0, y0);
  const n2 = node(`${prefix}-2`, x0 + size, y0);
  const n3 = node(`${prefix}-3`, x0 + size, y0 + size);
  const n4 = node(`${prefix}-4`, x0, y0 + size);
  return {
    edges: [
      edge(`${prefix}-e1`, n1, n2, owner),
      edge(`${prefix}-e2`, n2, n3, owner),
      edge(`${prefix}-e3`, n3, n4, owner),
      edge(`${prefix}-e4`, n4, n1, owner),
    ],
    minEdgeIdx: 0,
    innerAffiliation: owner,
    outerAffiliation: 'OTHER',
  } as unknown as BorderEdgeLoop;
}

describe('isLoopClosed', () => {
  it('detects id-closed and open loops', () => {
    expect(isLoopClosed(square('DC', 0, 0, 10, 'a'))).toEqual(true);
    const open = square('DC', 0, 0, 10, 'b');
    // Break closure with a FRESH node object (same coords, different id):
    // mutating the id in place would also rename the shared first node.
    const lastEdge = open.edges[open.edges.length - 1];
    lastEdge.node2 = { ...(lastEdge.node1 as object), id: 'zzz' } as never;
    expect(isLoopClosed(open)).toEqual(false);
  });
});

describe('findPocketHoles', () => {
  it('returns foreign loops fully inside own loops (Kobe class)', () => {
    const dc = square('DC', 0, 0, 100, 'dc');
    const pocket = square('LC', 40, 40, 10, 'lc');
    const holes = findPocketHoles([dc], { DC: [dc], LC: [pocket] }, 'DC');
    expect(holes.length).toEqual(1);
    expect(holes[0]).toBe(pocket);
  });

  it('ignores own-faction loops and empty/independent pockets', () => {
    const dc = square('DC', 0, 0, 100, 'dc');
    const dcInner = square('DC', 40, 40, 10, 'dc2');
    const indep = square('I', 60, 60, 5, 'i1');
    const holes = findPocketHoles([dc, dcInner], { DC: [dc, dcInner], I: [indep] }, 'DC');
    expect(holes.length).toEqual(0);
  });

  it('rejects partially-overlapping contours (no stray fills)', () => {
    const dc = square('DC', 0, 0, 100, 'dc');
    const straddler = square('LC', 90, 90, 30, 'lc');
    const holes = findPocketHoles([dc], { DC: [dc], LC: [straddler] }, 'DC');
    expect(holes.length).toEqual(0);
  });

  it('rejects open chains even when positioned inside', () => {
    const dc = square('DC', 0, 0, 100, 'dc');
    const open = square('LC', 40, 40, 10, 'lc');
    const lastEdge = open.edges[open.edges.length - 1];
    lastEdge.node2 = { ...(lastEdge.node1 as object), id: 'zzz' } as never;
    const holes = findPocketHoles([dc], { DC: [dc], LC: [open] }, 'DC');
    expect(holes.length).toEqual(0);
  });

  it('punches byte-identical twin pockets (Kobe class)', () => {
    // Production SVG shows both factions filling the byte-identical ring
    // contour (distinct node objects, identical coordinates). The pocket's
    // vertices lie exactly ON the twin's contour, so strict containment alone
    // would reject it — the boundary tolerance plus interior centroid admit it.
    const dcTwin = square('DC', 40, 40, 10, 'dc');
    const lcTwin = square('LC', 40, 40, 10, 'lc');
    const holes = findPocketHoles([dcTwin], { DC: [dcTwin], LC: [lcTwin] }, 'DC');
    expect(holes.length).toEqual(1);
    expect(holes[0]).toBe(lcTwin);
  });

  it('punches pockets sharing boundary segments with the parent', () => {
    // Pocket whose contour touches the parent contour along one side:
    // shared-vertex twins where half the verts sit exactly on the boundary.
    const parent = square('DC', 0, 0, 100, 'p');
    const pocket = square('LC', 0, 40, 20, 'q');
    // Move pocket's left side exactly onto the parent's left side (x=0).
    for (const e of pocket.edges) {
      for (const n of [e.node1, e.node2] as Array<{ x: number; y: number }>) {
        if (Math.abs(n.x - 0) < 0.0000005) n.x = 0;
      }
    }
    const holes = findPocketHoles([parent], { DC: [parent], LC: [pocket] }, 'DC');
    expect(holes.length).toEqual(1);
  });

  it('includes disputed zones by geometry, not key matching', () => {
    const fwl = square('FWL', 0, 0, 100, 'fwl');
    const disputed = square('D-FWL-CC', 40, 40, 10, 'd1');
    const holes = findPocketHoles([fwl], { FWL: [fwl], 'D-FWL-CC': [disputed] }, 'FWL');
    expect(holes.length).toEqual(1);
  });

  it('groups keys case-insensitively', () => {
    const grouped = groupBorderLoopsByUpperKey({ AuC: [square('AuC', 0, 0, 1, 'a')], AUC: [square('AUC', 5, 5, 1, 'b')] });
    expect(Object.keys(grouped)).toEqual(['AUC']);
    expect(grouped['AUC'].length).toEqual(2);
  });
});
