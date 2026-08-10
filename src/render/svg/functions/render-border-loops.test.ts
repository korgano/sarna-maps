import { expect, describe, it } from 'vitest';
import { renderBorderLoops } from './render-border-loops';
import { Faction } from '../../../common';

function factionMap(entries: Array<[string, string, string]>): Record<string, Faction> {
  const map: Record<string, Faction> = {};
  for (const [id, name, color] of entries) {
    map[id] = { id, name, color };
  }
  return map;
}

function loop(innerAffiliation: string | undefined, id = 'loop-1'): any {
  return {
    id,
    innerAffiliation,
    edges: [],
    minEdgeIdx: -1,
    length: 1,
  };
}

describe('renderBorderLoops disputed rendering', () => {
  it('emits a border-fill def whose id matches the CSS url target for a single-subfaction disputed key', () => {
    const factions = factionMap([
      ['LC', 'Lyran Commonwealth', '#3366cc'],
      ['DC', 'Draconis Combine', '#cc3333'],
    ]);

    // D-LC has only one sub-faction -> previously fell into the fallback
    // branch which emitted border-fill-D while the CSS referenced
    // border-fill-D-LC (an unresolved url -> black region).
    const result = renderBorderLoops(
      { 'D-LC': [loop('LC')] },
      factions,
      new Map(),
      'light',
      true,
      '',
    );

    expect(result.defs).to.contain('id="border-fill-D-LC"');
    expect(result.css).to.contain('fill: url(#border-fill-D-LC)');
  });

  it('keeps the def id and css url target aligned in prefix mode', () => {
    const factions = factionMap([
      ['LC', 'Lyran Commonwealth', '#3366cc'],
      ['DC', 'Draconis Combine', '#cc3333'],
    ]);

    const result = renderBorderLoops(
      { 'D-LC-DC': [loop('LC')] },
      factions,
      new Map(),
      'dark',
      true,
      'region-a',
    );

    expect(result.defs).to.contain('id="region-a-border-fill-D-LC-DC"');
    expect(result.css).to.contain('fill: url(#region-a-border-fill-D-LC-DC)');
  });

  it('sanitizes special characters in disputed keys so the def id, css url and class stay aligned', () => {
    const factions = factionMap([
      ['CC', 'Capellan Confederation', '#cc3333'],
      ['FS', 'Federated Suns', '#3366cc'],
    ]);

    // A disputed key containing parentheses and a slash (e.g. produced by the
    // voronoi pipeline for `D(CC/FS)`). Previously the def id, the url target
    // and the `.faction-border-*` class diverged / contained illegal CSS chars.
    const result = renderBorderLoops(
      { 'D(CC/FS)': [loop('CC')] },
      factions,
      new Map(),
      'light',
      true,
      'basemap',
    );

    // def id and css url target must both be sanitized and identical
    expect(result.defs).to.contain('id="basemap-border-fill-D_28CC_2fFS_29"');
    expect(result.css).to.contain('fill: url(#basemap-border-fill-D_28CC_2fFS_29)');
    // the markup class must match the sanitized css selector token
    expect(result.markup).to.contain('faction-border-D_28CC_2fFS_29');
    // neither the def id nor the css url may contain a raw parenthesis
    expect(result.defs).not.to.match(/border-fill-D\(/);
    expect(result.css).not.to.match(/border-fill-D\(/);
  });
});

describe('renderBorderLoops shared-boundary handling', () => {
  it('draws a boundary between two factions exactly once, colored by the inside faction', () => {
    const factions = factionMap([
      ['LC', 'Lyran Commonwealth', '#3366cc'],
      ['DC', 'Draconis Combine', '#cc3333'],
    ]);

    // The same territory loop (inner = LC) is reachable from BOTH faction keys,
    // as generateBorderLoops stores shared boundaries under each adjacent
    // faction. Previously this produced two overlapping fills (LC + DC colors).
    const result = renderBorderLoops(
      {
        LC: [loop('LC', 'shared')],
        DC: [loop('LC', 'shared')],
      },
      factions,
      new Map(),
      'light',
      true,
      '',
    );

    // The loop geometry must appear exactly once in the markup ...
    const pathCount = (result.markup.match(/<path /g) || []).length;
    expect(pathCount).to.equal(1);
    // ... wrapped in LC's layer (the owning/inside faction), not DC's.
    expect(result.markup).to.contain('faction-border-LC');
    expect(result.markup).not.to.contain('faction-border-DC');
  });

  it('skips open borders (no inner affiliation) entirely — never rendered as paths', () => {
    const factions = factionMap([
      ['LC', 'Lyran Commonwealth', '#3366cc'],
      ['DC', 'Draconis Combine', '#cc3333'],
    ]);

    const result = renderBorderLoops(
      {
        LC: [loop(undefined, 'open-1')],
      },
      factions,
      new Map(),
      'light',
      true,
      '',
    );

    // Open border (strandline with no inner affiliation) must not appear
    // in the output at all — no filled loop, no stroke-only path.
    expect(result.markup).to.equal('');
    expect(result.css).to.equal('');
  });
});

