import { expect, describe, it } from 'vitest';
import { generateSectionPath } from './generate-section-path';
import { BorderSection } from '../../../compute';

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

function squareSection(isLoop: boolean): BorderSection {
  const n1 = node('n1', 0, 0);
  const n2 = node('n2', 10, 0);
  const n3 = node('n3', 10, 10);
  const n4 = node('n4', 0, 10);
  const mkEdge = (id: string, a: typeof n1, b: typeof n1) => ({
    id,
    node1: a,
    node2: b,
    vertex1Idx: 0,
    vertex2Idx: 0,
    affiliation1: 'LC',
    affiliation2: 'DC',
    leftAffiliation: 'DC',
    rightAffiliation: 'LC',
    length: 10,
    closeness: 99,
  });
  return {
    id: 's1',
    edges: [mkEdge('e1', n1, n2), mkEdge('e2', n2, n3), mkEdge('e3', n3, n4), mkEdge('e4', n4, isLoop ? n1 : node('n5', 0, 20))],
    isLoop,
    affiliation1: 'LC',
    affiliation2: 'DC',
    node1: n1,
    node2: n1,
    length: 40,
    minEdgeIdx: 0,
  };
}

describe('generateSectionPath', () => {
  it('closes closed loops with Z so evenodd fills stay bounded', () => {
    const d = generateSectionPath(squareSection(true), false);
    expect(d.trim().endsWith('Z')).to.equal(true);
  });

  it('leaves open chains unclosed', () => {
    const d = generateSectionPath(squareSection(false), false);
    expect(d.trim().endsWith('Z')).to.equal(false);
  });

  it('returns empty for sections without edges', () => {
    const s = squareSection(true);
    s.edges = [];
    expect(generateSectionPath(s, false)).to.equal('');
  });
});
