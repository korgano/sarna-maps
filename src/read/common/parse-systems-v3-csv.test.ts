import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseSystemsV3Csv, parseYearCell, borderSeedingAffiliation } from './parse-systems-v3-csv';
import {
  clearPairingCache,
  getCacheEntryAttribute,
  getCacheEntryBorderID,
  getCacheEntryFactionColor,
  getCacheEntryNation,
  getCacheEntryVisible,
} from './retain-faction-affiliation-pairing';
import { Era, Faction, FactionRegistry, System } from '../../common';

const eras: Era[] = [
  { index: 0, name: '2271', year: 2271 },
  { index: 1, name: '3050', year: 3050 },
];

function makeSystem(id: string, eraAffiliations: string[]): System {
  return {
    id,
    name: `Test ${id}`,
    fullName: `Test ${id}`,
    x: 0,
    y: 0,
    radiusX: 1,
    radiusY: 1,
    rotation: 0,
    isCluster: false,
    eraAffiliations,
    eraCapitalLevels: eraAffiliations.map(() => 0),
    eraNames: eraAffiliations.map(() => `Test ${id}`),
  };
}

describe('parseYearCell', () => {
  it('splits the v3 pipe hierarchy into nation/district/region', () => {
    const parsed = parseYearCell('LC|Tamar Pact|Tamar Domains');
    expect(parsed.nation).toBe('LC');
    expect(parsed.district).toBe('Tamar Pact');
    expect(parsed.region).toBe('Tamar Domains');
  });

  it('splits the v1 comma hierarchy', () => {
    const parsed = parseYearCell('FS,Crucis March,New Avalon');
    expect(parsed.nation).toBe('FS');
    expect(parsed.district).toBe('Crucis March');
    expect(parsed.region).toBe('New Avalon');
  });

  it('reads the parenthetical of A(<FACTION>) as the attribute', () => {
    const parsed = parseYearCell('A(CFG)');
    expect(parsed.nation).toBe('A');
    expect(parsed.attribute).toBe('CFG');
  });

  it('keeps a disputed D(<SUB>) intact instead of splitting inside the parens', () => {
    const parsed = parseYearCell('D(LC,DC)');
    expect(parsed.nation).toBe('D');
    expect(parsed.attribute).toBe('LC,DC');
  });

  it('keeps a pipe-separated disputed head token intact', () => {
    const parsed = parseYearCell('D(DC|WB)|District');
    expect(parsed.nation).toBe('D');
    expect(parsed.attribute).toBe('DC|WB');
    expect(parsed.district).toBe('District');
  });

  it('treats a plain token as the nation', () => {
    expect(parseYearCell('U').nation).toBe('U');
    expect(parseYearCell('CJF').nation).toBe('CJF');
  });

  it('returns an empty result for empty input', () => {
    expect(parseYearCell('')).toEqual({ nation: '', attribute: '', district: '', region: '', zone: '', capital: '' });
  });
});

describe('borderSeedingAffiliation', () => {
  it('unwraps A(<FACTION>) while preserving the hierarchy tail', () => {
    expect(borderSeedingAffiliation('A(CFG)|District')).toBe('CFG|District');
    expect(borderSeedingAffiliation('A(CFG),District')).toBe('CFG,District');
    expect(borderSeedingAffiliation('A(CFG)')).toBe('CFG');
  });

  it('leaves bare A and the hidden marker A(H) as written', () => {
    expect(borderSeedingAffiliation('A')).toBe('A');
    expect(borderSeedingAffiliation('A(H)')).toBe('A(H)');
  });

  it('leaves non-abandoned cells untouched, including their tails', () => {
    expect(borderSeedingAffiliation('CJF|Tamar Pact|Tamar Domains')).toBe('CJF|Tamar Pact|Tamar Domains');
    expect(borderSeedingAffiliation('FS,Crucis March,New Avalon')).toBe('FS,Crucis March,New Avalon');
    expect(borderSeedingAffiliation('D(CJF/LC)')).toBe('D(CJF/LC)');
    expect(borderSeedingAffiliation('U')).toBe('U');
  });
});

describe('parseSystemsV3Csv (stage 2 enrichment)', () => {
  beforeEach(() => clearPairingCache());
  afterEach(() => clearPairingCache());

  it('records the border-seeding affiliation per system x era, tail intact', () => {
    const systems = [makeSystem('sys-1', ['A(CFG)|District', 'CJF|Tamar Pact|Tamar Domains'])];

    parseSystemsV3Csv(systems, eras);

    expect(getCacheEntryBorderID('sys-1_0')).toBe('CFG|District');
    expect(getCacheEntryBorderID('sys-1_1')).toBe('CJF|Tamar Pact|Tamar Domains');
  });

  it('records the bare nation token and the parenthetical attribute', () => {
    const systems = [makeSystem('sys-2', ['A(CFG)|District', 'U'])];

    parseSystemsV3Csv(systems, eras);

    expect(getCacheEntryNation('sys-2_0')).toBe('A');
    expect(getCacheEntryAttribute('sys-2_0')).toBe('CFG');
    expect(getCacheEntryNation('sys-2_1')).toBe('U');
    expect(getCacheEntryAttribute('sys-2_1')).toBe('');
  });

  it('keeps A and U visible when no visibility override is configured', () => {
    const systems = [makeSystem('sys-3', ['A', 'U'])];

    parseSystemsV3Csv(systems, eras);

    expect(getCacheEntryVisible('sys-3_0')).toBe(true);
    expect(getCacheEntryVisible('sys-3_1')).toBe(true);
  });

  it('resolves faction colors through the registry and defaults to black', () => {
    const faction: Faction = { id: 'CJF', name: 'Clan Jade Falcon', color: '#00FF00' };
    const registry = new FactionRegistry();
    registry.register(faction);
    const systems = [makeSystem('sys-4', ['CJF', 'XX'])];

    parseSystemsV3Csv(systems, eras, { factionRegistry: registry });

    expect(getCacheEntryFactionColor('sys-4_0')).toBe('#00FF00');
    expect(getCacheEntryFactionColor('sys-4_1')).toBe('#000000');
  });

  it('enriches every era of every system and returns the systems for chaining', () => {
    const systems = [
      makeSystem('sys-5', ['U', 'FS']),
      makeSystem('sys-6', ['DC', 'LC']),
    ];

    const result = parseSystemsV3Csv(systems, eras);

    expect(result).toBe(systems);
    expect(getCacheEntryBorderID('sys-5_0')).toBe('U');
    expect(getCacheEntryBorderID('sys-5_1')).toBe('FS');
    expect(getCacheEntryBorderID('sys-6_0')).toBe('DC');
    expect(getCacheEntryBorderID('sys-6_1')).toBe('LC');
  });
});
