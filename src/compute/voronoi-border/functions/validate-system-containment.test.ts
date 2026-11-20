import { expect, describe, it } from 'vitest';
import { validateSystemContainment } from './validate-system-containment';
import { BorderEdgeLoop } from '../types';
import { System } from '../../../common';

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

// Unit square loop (0,0)-(10,10) owned by the given faction.
function squareLoop(faction: string, dx = 0): BorderEdgeLoop {
  const n1 = node(`${faction}-n1`, dx, 0);
  const n2 = node(`${faction}-n2`, dx + 10, 0);
  const n3 = node(`${faction}-n3`, dx + 10, 10);
  const n4 = node(`${faction}-n4`, dx, 10);
  const mkEdge = (id: string, a: typeof n1, b: typeof n1) => ({
    id,
    node1: a,
    node2: b,
    vertex1Idx: 0,
    vertex2Idx: 0,
    affiliation1: faction,
    affiliation2: 'OTHER',
    leftAffiliation: 'OTHER',
    rightAffiliation: faction,
    length: 10,
    closeness: 99,
  });
  return {
    edges: [mkEdge(`${faction}-e1`, n1, n2), mkEdge(`${faction}-e2`, n2, n3), mkEdge(`${faction}-e3`, n3, n4), mkEdge(`${faction}-e4`, n4, n1)],
    minEdgeIdx: 0,
    innerAffiliation: faction,
    outerAffiliation: 'OTHER',
  };
}

function system(name: string, x: number, y: number, affiliation: string): System {
  return {
    id: name,
    name,
    x,
    y,
    radiusX: 0,
    radiusY: 0,
    rotation: 0,
    fullName: name,
    isCluster: false,
    eraAffiliations: [affiliation],
    eraCapitalLevels: [0],
    eraNames: ['Test Era'],
  };
}

describe('validateSystemContainment', () => {
  it('reports zero findings when every system is inside its own polygon', () => {
    const loops = { LC: [squareLoop('LC')], DC: [squareLoop('DC', 20)] };
    const systems = [system('A', 5, 5, 'LC'), system('B', 25, 5, 'DC')];
    const report = validateSystemContainment(loops, systems, 0);
    expect(report.checked).to.equal(2);
    expect(report.miscontained).to.equal(0);
    expect(report.outsideOwn).to.equal(0);
  });

  it('flags systems inside the wrong faction polygon', () => {
    const loops = { LC: [squareLoop('LC')], DC: [squareLoop('DC', 20)] };
    // LC system placed inside DC territory.
    const systems = [system('A', 25, 5, 'LC')];
    const report = validateSystemContainment(loops, systems, 0);
    expect(report.miscontained).to.equal(1);
    expect(report.outsideOwn).to.equal(1);
  });

  it('flags systems outside every polygon', () => {
    const loops = { LC: [squareLoop('LC')] };
    const systems = [system('A', 50, 50, 'LC')];
    const report = validateSystemContainment(loops, systems, 0);
    expect(report.miscontained).to.equal(0);
    expect(report.outsideOwn).to.equal(1);
  });

  it('accepts disputed-zone membership', () => {
    const loops = { 'D-LC-DC': [squareLoop('D-LC-DC')] };
    const systems = [system('A', 5, 5, 'D(LC/DC)')];
    const report = validateSystemContainment(loops, systems, 0);
    expect(report.outsideOwn).to.equal(0);
  });

  it('logs hidden worlds as guests inside a separate faction polygon', () => {
    const loops = { DC: [squareLoop('DC')] };
    const systems = [system('H', 5, 5, 'FWL(H)')];
    const report = validateSystemContainment(loops, systems, 0);
    expect(report.hiddenInsideOther).to.equal(1);
    expect(report.miscontained).to.equal(0);
    expect(report.outsideOwn).to.equal(0);
  });

  it('stays silent for hidden worlds inside nothing', () => {
    const loops = { DC: [squareLoop('DC')] };
    const systems = [system('H', 50, 50, 'FWL(H)')];
    const report = validateSystemContainment(loops, systems, 0);
    expect(report.hiddenInsideOther).to.equal(0);
    expect(report.miscontained).to.equal(0);
    expect(report.outsideOwn).to.equal(0);
  });

  it('logs independent worlds as outside all faction polygons', () => {
    const loops = { DC: [squareLoop('DC')] };
    const systems = [system('Ind', 50, 50, 'I')];
    const report = validateSystemContainment(loops, systems, 0);
    expect(report.independentOutsideAll).to.equal(1);
    expect(report.miscontained).to.equal(0);
    expect(report.outsideOwn).to.equal(0);
  });

  it('stays silent for independent enclaves inside a faction polygon', () => {
    const loops = { DC: [squareLoop('DC')] };
    const systems = [system('Ind', 5, 5, 'I')];
    const report = validateSystemContainment(loops, systems, 0);
    expect(report.independentOutsideAll).to.equal(0);
    expect(report.miscontained).to.equal(0);
    expect(report.outsideOwn).to.equal(0);
  });
});
