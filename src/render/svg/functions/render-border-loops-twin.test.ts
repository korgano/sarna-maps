import { expect, describe, it } from 'vitest';
import { renderBorderLoops } from './render-border-loops';
import { BorderEdgeLoop } from '../../../compute';
import { FactionRegistry } from '../../../common';

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

// Closed square pocket (0,0)-(10,10) with caller-owned node objects but
// globally-shared edge/node ids — exactly what twin faction loops look like
// after buildFactionLoops deep-cloning (same segment, both factions' lists).
// In production, separation offsets each copy onto its own parallel line, so
// both twins must keep their fill AND their stroke (no twin-skip: the pocket
// faction would otherwise lose its territory to the earlier-rendered neighbor,
// e.g. an LC pocket rendered entirely in DC colors).
function pocketLoop(owner: string): BorderEdgeLoop {
  const n1 = node('n1', 0, 0);
  const n2 = node('n2', 10, 0);
  const n3 = node('n3', 10, 10);
  const n4 = node('n4', 0, 10);
  return {
    edges: [
      edge('s1', n1, n2, owner),
      edge('s2', n2, n3, owner),
      edge('s3', n3, n4, owner),
      edge('s4', n4, n1, owner),
    ],
    minEdgeIdx: 0,
    innerAffiliation: owner,
    outerAffiliation: 'OTHER',
  } as unknown as BorderEdgeLoop;
}

describe('renderBorderLoops twin pockets', () => {
  it('fills and strokes both twins (no twin-skip)', () => {
    const registry = new FactionRegistry();
    const result = renderBorderLoops(
      { DC: [pocketLoop('DC')], LC: [pocketLoop('LC')] },
      { DC: [pocketLoop('DC')], LC: [pocketLoop('LC')] }, // fillLoops (same geometry for test)
      registry,
      new Map(),
      'dark',
      false,
    );

    // Both faction layers emitted with their own fill and their own stroke.
    expect(result.markup).toContain('faction-border-DC');
    expect(result.markup).toContain('faction-border-LC');

    // Two fills (stroke suppressed inline), two strokes (fill suppressed).
    const strokeNoneCount = (result.markup.match(/stroke: none/g) || []).length;
    expect(strokeNoneCount).toEqual(2);
    const fillNoneCount = (result.markup.match(/fill: none/g) || []).length;
    expect(fillNoneCount).toEqual(2);
  });

  it('keeps disputed loops fill-only (parents outline the zone)', () => {
    const registry = new FactionRegistry();
    const disputed = pocketLoop('D-DC-LC');
    const result = renderBorderLoops(
      { 'D-DC-LC': [disputed] },
      { 'D-DC-LC': [disputed] }, // fillLoops (same geometry for test)
      registry,
      new Map(),
      'dark',
      false,
    );
    // Pattern fill present, no faction-colored stroke claimed by the zone.
    expect(result.markup).toContain('faction-border-D-DC-LC');
    const fillNoneCount = (result.markup.match(/fill: none/g) || []).length;
    expect(fillNoneCount).toEqual(0);
  });
});
