import { expect, describe, it } from 'vitest';
import {
  isDisputedAffiliation,
  parseDisputedSubFactions,
  isDisputedZoneEdge,
} from './disputed-affiliation';

describe('isDisputedAffiliation', () => {
  it('recognizes all known disputed forms', () => {
    expect(isDisputedAffiliation('D')).to.equal(true);
    expect(isDisputedAffiliation('D-LC-DC')).to.equal(true);
    expect(isDisputedAffiliation('D-LC/DC')).to.equal(true);
    expect(isDisputedAffiliation('D-LC|DC')).to.equal(true);
    expect(isDisputedAffiliation('D(LC|DC)')).to.equal(true);
    expect(isDisputedAffiliation('D(LC/DC)')).to.equal(true);
  });

  it('rejects plain factions and empty input', () => {
    expect(isDisputedAffiliation('LC')).to.equal(false);
    expect(isDisputedAffiliation('FWL')).to.equal(false);
    expect(isDisputedAffiliation('')).to.equal(false);
    expect(isDisputedAffiliation(null)).to.equal(false);
    expect(isDisputedAffiliation(undefined)).to.equal(false);
  });
});

describe('parseDisputedSubFactions', () => {
  it('parses dash, slash, pipe, and paren forms identically', () => {
    expect(parseDisputedSubFactions('D-LC-DC')).to.deep.equal(['LC', 'DC']);
    expect(parseDisputedSubFactions('D-LC/DC')).to.deep.equal(['LC', 'DC']);
    expect(parseDisputedSubFactions('D-LC|DC')).to.deep.equal(['LC', 'DC']);
    expect(parseDisputedSubFactions('D(LC|DC)')).to.deep.equal(['LC', 'DC']);
    expect(parseDisputedSubFactions('D(LC/DC)')).to.deep.equal(['LC', 'DC']);
  });

  it('returns empty for bare D and non-disputed keys', () => {
    expect(parseDisputedSubFactions('D')).to.deep.equal([]);
    expect(parseDisputedSubFactions('LC')).to.deep.equal([]);
  });
});

describe('isDisputedZoneEdge', () => {
  it('detects dash-form disputed edges (previously missed by /-only checks)', () => {
    expect(isDisputedZoneEdge({ affiliation1: 'D-LC-DC', affiliation2: 'LC' })).to.equal(true);
    expect(isDisputedZoneEdge({ affiliation1: 'LC', affiliation2: 'DC' })).to.equal(false);
  });
});
