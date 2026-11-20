import { Faction, FactionRegistry, System, Era, logger } from '../../common';
import { traceFaction } from '../../common/utils/faction-traversal-logger';
import { normalizeFactionKey } from '../../common/utils/normalize-faction-key';

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
  nation: string;
  borderID: string;
  factionColor: string;
  visible: boolean;
  attribute: string;
}

/**
 * Per system x era values produced by the enrichment stage
 * (`parseSystemsV3Csv`) ahead of pairing.
 *
 * Deliberately a separate map from `pairingCache`: `buildFactionAffiliationPairs`
 * resets the pair cache on every build, and it must not reset these — it reads
 * them back out to populate `nation`/`borderID`/`factionColor`/`visible`/
 * `attribute` on each pair it builds. Callers reset both via
 * `clearPairingCache()` at the start of a read.
 */
interface EnrichmentEntry {
  nation: string;
  borderID: string;
  factionColor: string;
  visible: boolean;
  attribute: string;
}

const pairingCache: Map<string, FactionAffiliationPair> = new Map();
const enrichmentCache: Map<string, EnrichmentEntry> = new Map();

/**
 * Records the enrichment values for one system x era (stage 2 of the read
 * pipeline). Read back by `getCacheEntry*`, which the Voronoi pass and the
 * pair build both consult.
 */
export function setCacheEntry(
  key: string,
  data: { nation: string; borderID: string; factionColor: string; visible: boolean; attribute: string }
): void {
  enrichmentCache.set(key, data);
}

export function getCacheEntry(key: string): FactionAffiliationPair | null {
  return pairingCache.get(key) ?? null;
}

export function getCacheEntryNation(key: string): string {
  const enrichment = enrichmentCache.get(key);
  if (enrichment) return enrichment.nation;
  const entry = pairingCache.get(key);
  return entry ? entry.nation : '';
}

export function getCacheEntryBorderID(key: string): string {
  const enrichment = enrichmentCache.get(key);
  if (enrichment) return enrichment.borderID;
  const entry = pairingCache.get(key);
  return entry ? entry.borderID : '';
}

export function getCacheEntryFactionColor(key: string): string {
  const enrichment = enrichmentCache.get(key);
  if (enrichment) return enrichment.factionColor;
  const entry = pairingCache.get(key);
  return entry ? entry.factionColor : '#000000';
}

export function getCacheEntryVisible(key: string): boolean {
  const enrichment = enrichmentCache.get(key);
  if (enrichment) return enrichment.visible;
  const entry = pairingCache.get(key);
  return entry ? entry.visible : true;
}

export function getCacheEntryAttribute(key: string): string {
  const enrichment = enrichmentCache.get(key);
  if (enrichment) return enrichment.attribute;
  const entry = pairingCache.get(key);
  return entry ? entry.attribute : '';
}

/**
 * Resets all read-pipeline caching (pairing + enrichment). Called once per read
 * before the enrichment stage so a second read cannot inherit entries keyed by
 * system ids from the previous run.
 */
export function clearPairingCache(): void {
  pairingCache.clear();
  enrichmentCache.clear();
}

function normalizeAffiliationKey(raw: string, fileName: string, stage: string): string {
  if (!raw) {
    traceFaction(fileName, `${stage}:normalize:empty`, 'EMPTY');
    return '';
  }
  const normalized = normalizeFactionKey(raw);
  traceFaction(fileName, `${stage}:normalize:changed`, `${raw} -> ${normalized}`);
  return normalized;
}

function resolveFactionForEra(
  affiliationKey: string,
  era: Era,
  factionRegistry: FactionRegistry,
  fileName: string,
  stage: string
): { faction: Faction | null; status: FactionAffiliationPair['resolutionStatus'] } {
  if (!affiliationKey) {
    return { faction: null, status: 'missing-affiliation' };
  }

  let lookupKey = affiliationKey.toUpperCase();

  if (lookupKey.startsWith('D-')) {
    const subKeyParts = lookupKey.slice(2).split('-');
    const subCandidates: Faction[] = [];
    for (const part of subKeyParts) {
      const subCand = factionRegistry.get(part);
      if (subCand) subCandidates.push(subCand);
    }
    if (subCandidates.length > 0) {
      const valid = subCandidates.filter(f => {
        const foundingOk = f.founding === undefined || f.founding <= era.year;
        const dissolutionOk = f.dissolution === null || f.dissolution === undefined || f.dissolution >= era.year;
        return foundingOk && dissolutionOk;
      });
      if (valid.length === 0) return { faction: null, status: 'no-era-match' };
      if (valid.length > 1) return { faction: valid[0], status: 'multiple-matches' };
      return { faction: valid[0], status: 'success' };
    }
  }

  const candidate = factionRegistry.get(lookupKey);
  if (!candidate) return { faction: null, status: 'no-faction-match' };

  const foundingOk = candidate.founding === undefined || candidate.founding <= era.year;
  const dissolutionOk = candidate.dissolution === null || candidate.dissolution === undefined || candidate.dissolution >= era.year;
  if (!foundingOk || !dissolutionOk) return { faction: null, status: 'no-era-match' };

  return { faction: candidate, status: 'success' };
}

export function buildFactionAffiliationPairs(
  systems: System[],
  factionRegistry: FactionRegistry,
  eras: Era[]
): Map<string, FactionAffiliationPair> {
  pairingCache.clear();
  const fileName = 'retain-faction-affiliation-pairing.ts';
  const stage = 'build';
  const factions = factionRegistry.getAll();
  traceFaction(fileName, `${stage}:init`, `systems=${systems.length}, factions=${factions.length}`);

  for (const system of systems) {
    for (const era of eras) {
      const rawAffiliation = system.eraAffiliations?.[era.index] || '';
      const normalized = normalizeAffiliationKey(rawAffiliation, fileName, stage);
      const { faction, status } = resolveFactionForEra(normalized, era, factionRegistry, fileName, stage);
      const cacheKey = `${system.id}_${era.index}`;

      const pair: FactionAffiliationPair = {
        systemId: system.id,
        systemName: system.name,
        eraIndex: era.index,
        eraYear: era.year,
        rawAffiliation,
        normalizedAffiliation: normalized,
        faction,
        resolutionStatus: status,
        nation: getCacheEntryNation(cacheKey) || normalized,
        borderID: getCacheEntryBorderID(cacheKey) || normalized,
        factionColor: getCacheEntryFactionColor(cacheKey),
        visible: getCacheEntryVisible(cacheKey),
        attribute: getCacheEntryAttribute(cacheKey),
      };

      pairingCache.set(cacheKey, pair);
      traceFaction(fileName, `${stage}:output`, `${system.name}(${cacheKey}):${normalized}:${faction ? faction.id : 'NULL'}:${status}`, era.index);
    }
  }

  const statusToKey: Record<FactionAffiliationPair['resolutionStatus'], keyof typeof stats> = {
    'success': 'success',
    'missing-affiliation': 'missingAffiliation',
    'no-faction-match': 'noFactionMatch',
    'no-era-match': 'noEraMatch',
    'multiple-matches': 'multipleMatches'
  };
  const stats = { total: systems.length * eras.length, success: 0, missingAffiliation: 0, noFactionMatch: 0, noEraMatch: 0, multipleMatches: 0 };
  for (const pair of pairingCache.values()) {
    stats[statusToKey[pair.resolutionStatus]]++;
  }
  logger.info('retain-faction-affiliation-pairing.ts', `Pairing build complete: ${JSON.stringify(stats)}`);
  traceFaction(fileName, `${stage}:summary`, JSON.stringify(stats));

  return pairingCache;
}

export function getFactionAffiliationPair(
  systemId: string,
  eraIndex: number
): FactionAffiliationPair | null {
  return pairingCache.get(`${systemId}_${eraIndex}`) ?? null;
}

export function getCachedNation(systemId: string, eraIndex: number): string {
  return getCacheEntryNation(`${systemId}_${eraIndex}`);
}

export function getCachedBorderID(systemId: string, eraIndex: number): string {
  return getCacheEntryBorderID(`${systemId}_${eraIndex}`);
}

export function getCachedFactionColor(systemId: string, eraIndex: number): string {
  return getCacheEntryFactionColor(`${systemId}_${eraIndex}`);
}

export function getCachedVisible(systemId: string, eraIndex: number): boolean {
  return getCacheEntryVisible(`${systemId}_${eraIndex}`);
}

export function getCachedAttribute(systemId: string, eraIndex: number): string {
  return getCacheEntryAttribute(`${systemId}_${eraIndex}`);
}
