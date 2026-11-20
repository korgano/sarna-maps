import { describe, expect, it } from 'vitest';
import { getAbandonedBorderFaction, isAbandonedAffiliation } from './abandoned-affiliation';

describe('isAbandonedAffiliation', () => {
  it('matches bare A', () => {
    expect(isAbandonedAffiliation('A')).to.equal(true);
    expect(isAbandonedAffiliation(' a ')).to.equal(true);
  });

  it('matches A(<FACTION>)', () => {
    expect(isAbandonedAffiliation('A(CFG)')).to.equal(true);
    expect(isAbandonedAffiliation('a(cfg)')).to.equal(true);
    expect(isAbandonedAffiliation('A(AuC)')).to.equal(true);
  });

  it('matches A with hierarchy tails', () => {
    expect(isAbandonedAffiliation('A(CFG)|Sian Commonality')).to.equal(true);
    expect(isAbandonedAffiliation('A(CFG),District')).to.equal(true);
    expect(isAbandonedAffiliation('A, District')).to.equal(true);
  });

  it('does not match faction ids starting with A', () => {
    expect(isAbandonedAffiliation('AuC')).to.equal(false);
    expect(isAbandonedAffiliation('AUS')).to.equal(false);
    expect(isAbandonedAffiliation('FS')).to.equal(false);
    expect(isAbandonedAffiliation('LC,Protectorate of Donegal')).to.equal(false);
  });

  it('does not match other special states', () => {
    expect(isAbandonedAffiliation('U')).to.equal(false);
    expect(isAbandonedAffiliation('U(A)')).to.equal(false);
    expect(isAbandonedAffiliation('D(LC,DC)')).to.equal(false);
    expect(isAbandonedAffiliation('')).to.equal(false);
    expect(isAbandonedAffiliation(undefined)).to.equal(false);
    expect(isAbandonedAffiliation(null)).to.equal(false);
  });
});

describe('getAbandonedBorderFaction', () => {
  it('extracts the faction from A(<FACTION>)', () => {
    expect(getAbandonedBorderFaction('A(CFG)')).to.equal('CFG');
    expect(getAbandonedBorderFaction('a(cfg)')).to.equal('cfg');
    expect(getAbandonedBorderFaction('A(AuC)')).to.equal('AuC');
  });

  it('extracts the faction despite hierarchy tails', () => {
    expect(getAbandonedBorderFaction('A(CFG)|Sian Commonality')).to.equal('CFG');
    expect(getAbandonedBorderFaction('A(CFG),District')).to.equal('CFG');
  });

  it('returns empty string for bare A', () => {
    expect(getAbandonedBorderFaction('A')).to.equal('');
    expect(getAbandonedBorderFaction(' a ')).to.equal('');
  });

  it('returns empty string for the hidden marker A(H)', () => {
    expect(getAbandonedBorderFaction('A(H)')).to.equal('');
  });

  it('returns empty string for non-abandoned keys', () => {
    expect(getAbandonedBorderFaction('AuC')).to.equal('');
    expect(getAbandonedBorderFaction('FS')).to.equal('');
    expect(getAbandonedBorderFaction('')).to.equal('');
    expect(getAbandonedBorderFaction(undefined)).to.equal('');
    expect(getAbandonedBorderFaction(null)).to.equal('');
  });
});
