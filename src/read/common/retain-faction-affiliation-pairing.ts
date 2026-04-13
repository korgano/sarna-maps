import { Faction, System, Era } from '../../common';
import { traceFaction } from '../../common/utils/faction-traversal-logger';

export interface FactionAffiliationPair {
  systemId: string;
  systemName: string;
  eraIndex: number;
  eraYear: number;
  rawAffiliation: string;
  normalizedAffiliation: string;
  faction: Faction | null;
  resolutionStatus:
    | 'success'
    | 'missing-affiliation'
    | 'no-faction-match'
    | 'no-era-match'
    | 'multiple-matches';
}

const pairingCache: Map<string, FactionAffiliationPair> = new Map();

/**
 * Normalize affiliation keys (centralized fix point)
 */
function normalizeAffiliationKey(raw: string, fileName: string, stage: string): string {
  if (!raw) {
    traceFaction(fileName, `${stage}:normalize:empty`, 'EMPTY');
    return '';
  }

  // Known normalization issue
  const normalized = raw.replace(/CIZ[1-3][A-C]/, 'CIZ');

  if (raw !== normalized) {
    traceFaction(fileName, `${stage}:normalize:changed`, `${raw} -> ${normalized}`);
  } else {
    traceFaction(fileName, `${stage}:normalize:unchanged`, raw);
  }

  return normalized;
}

/**
 * Build lookup: factionId → factions[]
 */
function buildFactionLookup(factions: Faction[]): Map<string, Faction[]> {
  const map = new Map<string, Faction[]>();

  for (const faction of factions) {
    if (!map.has(faction.id)) {
      map.set(faction.id, []);
    }

    map.get(faction.id)!.push(faction);
  }

  return map;
}

/**
 * Resolve faction with full diagnostic states
 */
function resolveFactionForEra(
  affiliationKey: string,
  era: Era,
  factionLookup: Map<string, Faction[]>,
  fileName: string,
  stage: string
): { faction: Faction | null; status: FactionAffiliationPair['resolutionStatus'] } {

  if (!affiliationKey) {
    traceFaction(fileName, `${stage}:resolve:missing-affiliation`, 'EMPTY');
    return { faction: null, status: 'missing-affiliation' };
  }

  const candidates = factionLookup.get(affiliationKey);

  if (!candidates || candidates.length === 0) {
    traceFaction(fileName, `${stage}:resolve:no-faction-match`, affiliationKey);
    return { faction: null, status: 'no-faction-match' };
  }

  const valid = candidates.filter(f =>
    (f.founding === undefined || f.founding <= era.year) &&
    (f.dissolution === undefined || f.dissolution >= era.year)
  );

  if (valid.length === 0) {
    traceFaction(fileName, `${stage}:resolve:no-era-match`, affiliationKey);
    return { faction: null, status: 'no-era-match' };
  }

  if (valid.length > 1) {
    traceFaction(fileName, `${stage}:resolve:multiple-matches`, affiliationKey);
    return { faction: valid[0], status: 'multiple-matches' };
  }

  traceFaction(fileName, `${stage}:resolve:success`, affiliationKey);
  return { faction: valid[0], status: 'success' };
}

/**
 * Build all pairings once
 */
export function buildFactionAffiliationPairs(
  systems: System[],
  factions: Faction[],
  eras: Era[]
): Map<string, FactionAffiliationPair> {

  const fileName = 'retain-faction-affiliation-pairing.ts';
  const stage = 'build';

  const factionLookup = buildFactionLookup(factions);

  traceFaction(fileName, `${stage}:init`, `systems=${systems.length}, factions=${factions.length}`);

  for (const system of systems) {
    for (const era of eras) {

        const rawAffiliation = system.eraAffiliations?.[era.index] || '';


      traceFaction(
        fileName,
        `${stage}:input`,
        `${system.id}:${era.year}:${rawAffiliation}`
      );

      const normalized = normalizeAffiliationKey(rawAffiliation, fileName, stage);

      const { faction, status } = resolveFactionForEra(
        normalized,
        era,
        factionLookup,
        fileName,
        stage
      );

        const cacheKey = `${system.id}_${era.index}`;


      const pair: FactionAffiliationPair = {
        systemId: system.id,
        systemName: system.name,
        eraIndex: era.index,
        eraYear: era.year,
        rawAffiliation,
        normalizedAffiliation: normalized,
        faction,
        resolutionStatus: status
      };

      pairingCache.set(cacheKey, pair);

      traceFaction(
        fileName,
        `${stage}:output`,
        `${cacheKey}:${normalized}:${faction ? faction.id : 'NULL'}:${status}`
      );
    }
  }

  return pairingCache;
}

/**
 * Render-safe accessor (never throws)
 */
export function getFactionAffiliationPair(
  systemId: string,
  eraIndex: number
): FactionAffiliationPair | null {

    const key = `${systemId}_${eraIndex}`;
  return pairingCache.get(key) || null;
}