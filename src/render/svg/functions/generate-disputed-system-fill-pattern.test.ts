import { describe, it, expect } from 'vitest';
import { generateDisputedSystemFillPattern } from './generate-disputed-system-fill-pattern';
import { sanitizeFactionToken } from './sanitize-faction-token';
import { Faction } from '../../../common';

const factions: Record<string, Faction> = {
  LC: { id: 'LC', name: 'Lyran Commonwealth', color: '#4477cc' },
  DC: { id: 'DC', name: 'Draconis Combine', color: '#cc4444' },
  CC: { id: 'CC', name: 'Capellan Confederation', color: '#44cc44' },
  FS: { id: 'FS', name: 'Federated Suns', color: '#cccc44' },
};

/** Extracts the id="..." emitted on the <pattern> element. */
function patternId(markup: string): string | null {
  return markup.match(/<pattern id="([^"]+)"/)?.[1] ?? null;
}

describe('generateDisputedSystemFillPattern', () => {
  it('emits a pattern id that matches the sanitized url() reference', () => {
    // render-systems.ts references `url(#<prefix>system-fill-<safeKey>)`.
    for (const key of ['D-LC-DC', 'D-CC/FS', 'D(CC/FS)', 'D-CC-FS']) {
      const markup = generateDisputedSystemFillPattern(key, factions);
      const expected = `system-fill-${sanitizeFactionToken(key)}`;
      expect(patternId(markup), `id for ${key}`).to.equal(expected);
    }
  });

  it('produces an id that is a legal SVG id (no illegal characters)', () => {
    const markup = generateDisputedSystemFillPattern('D-CC/FS', factions);
    const id = patternId(markup) as string;

    expect(id).to.not.contain('/');
    expect(id).to.not.contain('(');
    expect(id).to.not.contain(')');
    expect(id).to.match(/^[A-Za-z0-9_-]+$/);
  });

  it('honours the def prefix so regional layers stay isolated', () => {
    const markup = generateDisputedSystemFillPattern('D-LC-DC', factions, 'region-a-');

    expect(patternId(markup)).to.equal('region-a-system-fill-D-LC-DC');
  });

  it('declares patternUnits and disables aspect-ratio letterboxing', () => {
    const markup = generateDisputedSystemFillPattern('D-LC-DC', factions);

    expect(markup).to.contain('patternUnits="objectBoundingBox"');
    // Required so elliptical cluster icons are fully covered rather than
    // letterboxed with unpainted bands.
    expect(markup).to.contain('preserveAspectRatio="none"');
    expect(markup).to.contain('viewBox="-1 -1 2 2"');
  });

  it('rotates via a presentation attribute, not a CSS style transform', () => {
    const markup = generateDisputedSystemFillPattern('D-LC-DC', factions);

    expect(markup).to.contain('<g transform="rotate(-90)">');
    expect(markup).to.not.contain('style="transform:rotate');
  });

  it('emits one closed wedge per faction, in that faction colour', () => {
    const markup = generateDisputedSystemFillPattern('D-LC-DC', factions);
    const paths = markup.match(/<path /g) || [];

    expect(paths.length).to.equal(2);
    expect(markup).to.contain('fill:#4477cc');
    expect(markup).to.contain('fill:#cc4444');
    // Every wedge must be explicitly closed, else the fill can leak.
    expect((markup.match(/L0,0Z/g) || []).length).to.equal(2);
  });

  it('writes plain decimal coordinates (never exponent notation)', () => {
    // cos/sin of the slice angles yield values like 6.12e-17; SVG path parsers
    // are not required to accept exponent notation.
    for (const key of ['D-LC-DC', 'D-LC-DC-CC', 'D-LC-DC-CC-FS']) {
      const markup = generateDisputedSystemFillPattern(key, factions);
      const d = markup.match(/ d="([^"]+)"/g) || [];
      for (const segment of d) {
        expect(segment, `${key}: ${segment}`).to.not.match(/e[+-]\d/i);
      }
    }
  });

  it('sets the large-arc flag only for slices bigger than a half circle', () => {
    // Three factions => 120 degrees per slice => short arc.
    const three = generateDisputedSystemFillPattern('D-LC-DC-CC', factions);
    expect(three).to.contain('A1,1,0,0,1,');
    expect(three).to.not.contain('A1,1,0,1,1,');
  });

  it('divides the circle evenly for 2, 3 and 4 factions', () => {
    expect((generateDisputedSystemFillPattern('D-LC-DC', factions).match(/<path /g) || []).length).to.equal(2);
    expect((generateDisputedSystemFillPattern('D-LC-DC-CC', factions).match(/<path /g) || []).length).to.equal(3);
    expect((generateDisputedSystemFillPattern('D-LC-DC-CC-FS', factions).match(/<path /g) || []).length).to.equal(4);
  });

  it('falls back to grey for an unknown faction rather than dropping the slice', () => {
    const markup = generateDisputedSystemFillPattern('D-LC-ZZZ', factions);

    expect((markup.match(/<path /g) || []).length).to.equal(2);
    expect(markup).to.contain('#999999');
  });

  it('returns nothing for a key naming fewer than two factions', () => {
    expect(generateDisputedSystemFillPattern('D-LC', factions)).to.equal('');
  });
});
