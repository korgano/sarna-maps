import { expect, describe, it } from 'vitest';
import { BorderEdgeLoop } from '../../../compute';
import { FactionRegistry, System } from '../../../common';
import {
  anyRegionCovers,
  buildFillEntries,
  buildFillRegions,
  detectOverlappingRegions,
  loopToPoints,
  polylineToPathD,
  regionCovers,
  trimStrokeAgainstDots,
  trimStrokeAgainstRegions,
} from './fill-constraints';
import { renderBorderLoops } from './render-border-loops';

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

function system(x: number, y: number) {
  return ({ x, y, radiusX: 3, radiusY: 3 }) as unknown as System;
}

function squareLoop(owner: string, x0: number, y0: number, x1: number, y1: number): BorderEdgeLoop {
  const n1 = node(`${owner}n1`, x0, y0);
  const n2 = node(`${owner}n2`, x1, y0);
  const n3 = node(`${owner}n3`, x1, y1);
  const n4 = node(`${owner}n4`, x0, y1);
  return {
    edges: [
      edge(`${owner}s1`, n1, n2, owner),
      edge(`${owner}s2`, n2, n3, owner),
      edge(`${owner}s3`, n3, n4, owner),
      edge(`${owner}s4`, n4, n1, owner),
    ],
    minEdgeIdx: 0,
    innerAffiliation: owner,
    outerAffiliation: 'OTHER',
  } as unknown as BorderEdgeLoop;
}

function regionFor(owner: string, allLoops: Record<string, Array<BorderEdgeLoop>>) {
  const entries = buildFillEntries(owner, false, allLoops[owner] || [], allLoops, false);
  return buildFillRegions({ [owner]: entries });
}

/** Parses `M x,y L x,y ...` stroke paths back into map-space point chains. */
function strokePointChains(markup: string): Array<Array<{ x: number; y: number }>> {
  const chains: Array<Array<{ x: number; y: number }>> = [];
  const re = /d="([^"]+)" style="fill: none"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(markup)) !== null) {
    const coords = [...match[1].matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)];
    chains.push(coords.map((c) => ({ x: parseFloat(c[1]), y: -parseFloat(c[2]) })));
  }
  return chains;
}

/** Collects the stroke point chains of one faction's own <g> layer. */
function strokeChainsOfFaction(markup: string, faction: string): Array<Array<{ x: number; y: number }>> {
  const groupRe = new RegExp(`<g data-name="${faction}"[^>]*>([\\s\\S]*?)<\\/g>`);
  const group = groupRe.exec(markup);
  return group ? strokePointChains(group[1]) : [];
}

describe('fill-constraints geometry', () => {
  it('flattens straight loops into a closed point chain', () => {
    const pts = loopToPoints(squareLoop('DC', 0, 0, 10, 10), false);
    expect(pts).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 0, y: 0 },
    ]);
  });

  it('leaves a stroke that never enters a foreign fill untouched', () => {
    const regions = regionFor('DC', { DC: [squareLoop('DC', 0, 0, 10, 10)] });
    const outside = [
      { x: 20, y: 20 },
      { x: 30, y: 30 },
    ];
    const result = trimStrokeAgainstRegions(outside, regions);
    expect(result.changed).toBe(false);
    expect(result.pieces[0]).toBe(outside);
  });

  it('keeps a stroke that runs exactly along a foreign fill contour', () => {
    const regions = regionFor('DC', { DC: [squareLoop('DC', 0, 0, 10, 10)] });
    const loop = squareLoop('LC', 0, 0, 10, 10);
    const onBoundary = loopToPoints(loop, false);
    const result = trimStrokeAgainstRegions(onBoundary, regions);
    expect(result.changed).toBe(false);
  });

  it('trims the stretch of a stroke that crosses a foreign fill', () => {
    const regions = regionFor('DC', { DC: [squareLoop('DC', 0, 0, 10, 10)] });
    const crossing = [
      { x: -5, y: 5 },
      { x: 15, y: 5 },
    ];
    const result = trimStrokeAgainstRegions(crossing, regions);
    expect(result.changed).toBe(true);
    expect(result.pieces.length).toEqual(2);
    expect(result.pieces[0]).toEqual([
      { x: -5, y: 5 },
      { x: 0, y: 5 },
    ]);
    expect(result.pieces[1]).toEqual([
      { x: 10, y: 5 },
      { x: 15, y: 5 },
    ]);
  });

  it('drops a stroke fully swallowed by a foreign fill', () => {
    const regions = regionFor('DC', { DC: [squareLoop('DC', 0, 0, 10, 10)] });
    const inside = [
      { x: 2, y: 5 },
      { x: 8, y: 5 },
    ];
    const result = trimStrokeAgainstRegions(inside, regions);
    expect(result.changed).toBe(true);
    expect(result.pieces.length).toEqual(0);
  });

  it('reports enclosure for disks (inside, hole, outside)', () => {
    const dc = squareLoop('DC', 0, 0, 10, 10);
    const lc = squareLoop('LC', 2, 2, 8, 8);
    const regions = regionFor('DC', { DC: [dc], LC: [lc] });
    expect(regionCovers(regions[0], { x: 1, y: 1 })).toBe(true);
    // LC pocket is a hole: the DC fill must not claim it.
    expect(regionCovers(regions[0], { x: 4, y: 4 })).toBe(false);
    expect(regionCovers(regions[0], { x: 11, y: 5 })).toBe(false);
    expect(anyRegionCovers(regions, { x: 5, y: 9 })).toBe(true);
    expect(anyRegionCovers(regions, { x: 20, y: 20 })).toBe(false);
  });

  it('emits the rendered fill path with its pocket holes in one d attribute', () => {
    const dc = squareLoop('DC', 0, 0, 10, 10);
    const lc = squareLoop('LC', 2, 2, 8, 8);
    const entries = buildFillEntries('DC', false, [dc], { DC: [dc], LC: [lc] }, false);
    expect(entries.length).toEqual(1);
    expect(entries[0].holePathDs.length).toEqual(1);
    expect(entries[0].pathD.trim().startsWith('M0.00,0.00')).toBe(true);
    expect(polylineToPathD(entries[0].contours[1])).toContain('L');
  });

  it('admits a pocket hole whose vertices graze the parent contour (on-contour tolerance)', () => {
    // LC twin shares DC's exact boundary: every LC vertex lies ON DC's contour.
    // findPocketHoles admits it (1e-6 on-contour tolerance). The old buildFillEntries
    // re-filter used strict polygonContains and dropped it, so the parent fill
    // painted over the pocket. The on-contour tolerance must keep it admitted.
    const dc = squareLoop('DC', 0, 0, 10, 10);
    const lcTwin = squareLoop('LC', 0, 0, 10, 10); // same boundary, different node ids
    const entries = buildFillEntries('DC', false, [dc], { DC: [dc], LC: [lcTwin] }, false);
    expect(entries.length).toEqual(1);
    expect(entries[0].holes).toHaveLength(1);
    expect(entries[0].holePathDs).toHaveLength(1);
  });

  it('excludes a pocket hole that contains one of the parent faction\'s own systems', () => {
    // DC owns a system at (5,5). LC has a loop (2,2)-(8,8) inside DC that
    // covers DC's system. Admitting LC as a DC pocket hole would swallow DC's
    // own system out of DC's fill (border stroke with no fill, white dot). The
    // own-system guard must exclude LC from DC's holes.
    const dc = squareLoop('DC', 0, 0, 10, 10);
    const lcInside = squareLoop('LC', 2, 2, 8, 8); // contains (5,5)
    const entries = buildFillEntries(
      'DC', false, [dc], { DC: [dc], LC: [lcInside] }, false,
      { DC: [system(5, 5)] },
    );
    expect(entries.length).toEqual(1);
    expect(entries[0].holes).toHaveLength(0);
    expect(entries[0].holePathDs).toHaveLength(0);
  });

  it('still admits a pocket hole that contains no parent-faction system', () => {
    // DC owns no system inside LC's inner loop, so LC remains a valid pocket hole.
    const dc = squareLoop('DC', 0, 0, 10, 10);
    const lcInside = squareLoop('LC', 2, 2, 8, 8);
    const entries = buildFillEntries(
      'DC', false, [dc], { DC: [dc], LC: [lcInside] }, false,
      {}, // no DC systems inside the hole
    );
    expect(entries.length).toEqual(1);
    expect(entries[0].holes).toHaveLength(1);
    expect(entries[0].holePathDs).toHaveLength(1);
  });
});

describe('trimStrokeAgainstDots', () => {
  it('keeps a stroke that stays outside all system dots', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ];
    const result = trimStrokeAgainstDots(points, [{ x: 5, y: 5, radius: 1 }], 0.5);
    expect(result.changed).toBe(false);
    expect(result.pieces[0]).toEqual(points);
  });

  it('drops a stroke that runs through a system dot', () => {
    const points = [
      { x: 4, y: 0 },
      { x: 6, y: 0 },
    ];
    const result = trimStrokeAgainstDots(points, [{ x: 5, y: 0, radius: 1 }], 0.5);
    // dot radius 1 + stroke clearance 0.5 = 1.5 fully covers the segment
    expect(result.changed).toBe(true);
    expect(result.pieces.length).toEqual(0);
  });

  it('splits a stroke into outside pieces around a dot', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ];
    const result = trimStrokeAgainstDots(points, [{ x: 5, y: 0, radius: 1 }], 0.5);
    // clearance 1.5 around (5,0) covers x in [3.5, 6.5]
    expect(result.changed).toBe(true);
    expect(result.pieces.length).toEqual(2);
    expect(result.pieces[0]).toEqual([
      { x: 0, y: 0 },
      { x: 3.5, y: 0 },
    ]);
    expect(result.pieces[1]).toEqual([
      { x: 6.5, y: 0 },
      { x: 10, y: 0 },
    ]);
  });

  it('returns everything untouched when there are no dots', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ];
    const result = trimStrokeAgainstDots(points, [], 0.5);
    expect(result.changed).toBe(false);
    expect(result.pieces[0]).toEqual(points);
  });
});

describe('renderBorderLoops no-overlap constraints', () => {
  const registry = new FactionRegistry();

  it('skips radius disks for systems already enclosed by a fill', () => {
    const system = (x: number, y: number) =>
      ({ x, y, radiusX: 3, radiusY: 3 }) as unknown as System;
    const result = renderBorderLoops(
      { DC: [squareLoop('DC', 0, 0, 10, 10)] },
      { DC: [squareLoop('DC', 0, 0, 10, 10)] }, // fillLoops (same geometry for test)
      registry,
      new Map(),
      'dark',
      false,
      '',
      { DC: [system(5, 5), system(50, 50)] },
    );
    const circles = result.markup.match(/<circle[^>]*>/g) || [];
    expect(circles.length).toEqual(1);
    expect(circles[0]).toContain('cx="50.000"');
  });

  it('keeps radius disks for genuinely uncovered systems', () => {
    const system = (x: number, y: number) =>
      ({ x, y, radiusX: 3, radiusY: 3 }) as unknown as System;
    const result = renderBorderLoops(
      {},
      {},
      registry,
      new Map(),
      'dark',
      false,
      '',
      { DC: [system(5, 5)] },
    );
    expect(result.markup).toContain('<circle');
  });

  it('trims strokes so no stroke midpoint sits inside a foreign fill', () => {
    const dc = squareLoop('DC', 0, 0, 10, 10);
    const lc = squareLoop('LC', 5, 5, 15, 15);
    const allLoops = { DC: [dc], LC: [lc] };
    const result = renderBorderLoops(
      allLoops,
      allLoops, // fillLoops (same geometry for test)
      registry,
      new Map(),
      'dark',
      false,
    );

    expect(result.markup).toContain('faction-border-DC');
    expect(result.markup).toContain('faction-border-LC');

    const dcRegion = regionFor('DC', allLoops)[0];
    const lcRegion = regionFor('LC', allLoops)[0];
    const foreignOf: Record<string, typeof dcRegion> = { DC: lcRegion, LC: dcRegion };

    let checked = 0;
    for (const [faction, foreign] of Object.entries(foreignOf)) {
      const chains = strokeChainsOfFaction(result.markup, faction);
      expect(chains.length).toBeGreaterThan(0);
      for (const chain of chains) {
        for (let i = 0; i < chain.length - 1; i++) {
          const mid = {
            x: (chain[i].x + chain[i + 1].x) / 2,
            y: (chain[i].y + chain[i + 1].y) / 2,
          };
          expect(regionCovers(foreign, mid, 0.001)).toBe(false);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(4);
  });

  it('leaves coincident twin loops fully stroked and filled', () => {
    const twin = squareLoop('DC', 0, 0, 10, 10);
    const twin2 = squareLoop('LC', 0, 0, 10, 10);
    const result = renderBorderLoops(
      { DC: [twin], LC: [twin2] },
      { DC: [twin], LC: [twin2] }, // fillLoops (same geometry for test)
      registry,
      new Map(),
      'dark',
      false,
    );
    expect((result.markup.match(/stroke: none/g) || []).length).toEqual(2);
    expect((result.markup.match(/fill: none/g) || []).length).toEqual(2);
  });

  it('trims strokes that would run through one of its own system dots', () => {
    const system = (x: number, y: number, rx: number, ry: number) =>
      ({ x, y, radiusX: rx, radiusY: ry }) as unknown as System;
    // Dot centred on the loop with a radius that covers the whole boundary:
    // the border stroke would run through the dot and must be trimmed away.
    const result = renderBorderLoops(
      { DC: [squareLoop('DC', 0, 0, 10, 10)] },
      { DC: [squareLoop('DC', 0, 0, 10, 10)] }, // fillLoops (same geometry for test)
      registry,
      new Map(),
      'dark',
      false,
      '',
      { DC: [system(5, 5, 10, 10)] },
    );
    // No stroke may survive when it overlaps the system dot.
    expect(result.markup).not.toContain('style="fill: none"');
  });

  it('trims bezier curve that bows through a dot between coarse chord samples', () => {
    // A bezier curve from (0,0) to (10,0) bows through dot at (5,5).
    // With 8 samples per curve (default), chords may all stay outside the
    // clearance zone; with 32 samples (DOT_TRIM_SAMPLES), a chord enters it.
    // Fine-sampled points include a point within clearance of the dot that
    // coarse-sampled points miss.
    const dot = { x: 5, y: 5, radius: 1 };
    const strokeClearance = 0.5;
    const clearance = dot.radius + strokeClearance; // 1.5

    // Coarse points (8 samples): all chords stay outside clearance zone
    const coarsePoints = [
      { x: 0, y: 0 },
      { x: 2.5, y: 0 },
      { x: 5, y: 0 },
      { x: 7.5, y: 0 },
      { x: 10, y: 0 },
    ];
    const coarseResult = trimStrokeAgainstDots(coarsePoints, [dot], strokeClearance);
    expect(coarseResult.changed).toBe(false);

    // Fine points (32 samples): includes a point within clearance of the dot
    const finePoints = [
      { x: 0, y: 0 },
      { x: 4.2, y: 4.2 },  // dist to (5,5) = ~1.13 < 1.5 clearance
      { x: 10, y: 0 },
    ];
    const fineResult = trimStrokeAgainstDots(finePoints, [dot], strokeClearance);
    expect(fineResult.changed).toBe(true);
    expect(fineResult.pieces.length).toBeGreaterThan(0);
  });
});

describe('detectOverlappingRegions', () => {
  const buildTwoFactionRegions = (
    dcLoop: ReturnType<typeof squareLoop>,
    lcLoop: ReturnType<typeof squareLoop>,
  ) => {
    const entriesByKey = {
      DC: buildFillEntries('DC', false, [dcLoop], { DC: [dcLoop], LC: [lcLoop] }, false),
      LC: buildFillEntries('LC', false, [lcLoop], { DC: [dcLoop], LC: [lcLoop] }, false),
    };
    return buildFillRegions(entriesByKey);
  };

  it('reports no overlaps for disjoint territories', () => {
    const dc = squareLoop('DC', 0, 0, 10, 10);
    const lc = squareLoop('LC', 20, 0, 30, 10);
    const regions = buildTwoFactionRegions(dc, lc);
    expect(detectOverlappingRegions(regions)).toEqual([]);
  });

  it('reports no overlaps for territories that only share a boundary', () => {
    const dc = squareLoop('DC', 0, 0, 10, 10);
    const lc = squareLoop('LC', 10, 0, 20, 10); // shares the x=10 edge with DC
    const regions = buildTwoFactionRegions(dc, lc);
    expect(detectOverlappingRegions(regions)).toEqual([]);
  });

  it('reports an overlap when one faction territory strictly contains another', () => {
    const dc = squareLoop('DC', 0, 0, 10, 10);
    const lc = squareLoop('LC', 5, 5, 15, 15); // genuinely overlaps DC interior
    const regions = buildTwoFactionRegions(dc, lc);
    const conflicts = detectOverlappingRegions(regions);
    expect(conflicts.length).toEqual(1);
    expect(conflicts[0].factionA).toBe('DC');
    expect(conflicts[0].factionB).toBe('LC');
    expect(conflicts[0].detail).toContain('contains');
  });

  it('does not report an enclave as an overlap (pocket-hole semantics)', () => {
    const dc = squareLoop('DC', 0, 0, 10, 10);
    const lc = squareLoop('LC', 2, 2, 8, 8); // LC enclave inside DC: legit pocket
    const regions = buildTwoFactionRegions(dc, lc);
    expect(detectOverlappingRegions(regions)).toEqual([]);
  });
});
