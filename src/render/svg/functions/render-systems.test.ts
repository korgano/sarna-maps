import { expect, describe, it } from 'vitest';
import { renderSystems } from './render-systems';
import { Faction, System } from '../../../common';

function factionMap(entries: Array<[string, string, string]>): Record<string, Faction> {
  const map: Record<string, Faction> = {};
  for (const [id, name, color] of entries) {
    map[id] = { id, name, color };
  }
  return map;
}

function system(
  id: string,
  name: string,
  affiliation: string,
  x = 0,
  y = 0,
): System {
  return {
    id,
    name,
    x,
    y,
    fullName: name,
    isCluster: false,
    radiusX: 0,
    radiusY: 0,
    rotation: 0,
    eraAffiliations: [affiliation],
    eraCapitalLevels: [0],
    eraNames: [name],
  };
}

describe('renderSystems disputed rendering', () => {
  it('emits a pattern def + url for a disputed D(LC|DC) system and never falls back to default #000', () => {
    const factions = factionMap([
      ['LC', 'Lyran Commonwealth', '#3366cc'],
      ['DC', 'Draconis Combine', '#cc3333'],
    ]);

    const result = renderSystems(
      [system('sys-1', 'Disputed System', 'D(LC|DC)')],
      factions,
      new Map(),
      'light',
      0,
      '',
      1,
    );

    // Pattern def must be present for the normalized disputed key.
    expect(result.defs).to.contain('system-fill-D-LC-DC');

    // SVG markup must stamp the disputed class on the system element.
    expect(result.markup).to.contain('class="system D-LC-DC"');
    expect(result.css).to.contain('fill: url(#system-fill-D-LC-DC)');

    // The disputed class must not rely on a default black fill (#000).
    expect(result.css).to.not.match(/D-LC-DC[^}]*fill:\s*#000/i);
    expect(result.css).to.not.contain('#000000');
  });

  it('does not leave a disputed system styled as default black fill', () => {
    const factions = factionMap([
      ['LC', 'Lyran Commonwealth', '#3366cc'],
      ['DC', 'Draconis Combine', '#cc3333'],
    ]);

    const result = renderSystems(
      [system('sys-2', 'Another Disputed', 'D(LC|DC)')],
      factions,
      new Map(),
      'dark',
      0,
      'region-a',
      1,
    );

    // Prefix mode: def id + url both carry the prefix and the same factionKey.
    expect(result.defs).to.contain('id="region-a-system-fill-D-LC-DC"');
    expect(result.css).to.contain('fill: url(#region-a-system-fill-D-LC-DC)');

    // No black fallback for the disputed class.
    expect(result.css).to.not.match(/D-LC-DC[^}]*fill:\s*#000/i);
  });
});
