import { Faction } from '../../../common';
import { FactionAffiliationPair } from '../../../read/common/retain-faction-affiliation-pairing';
import { getFactionAffiliationPair } from '../../../read/common/retain-faction-affiliation-pairing';

export interface FactionRenderStyle {
  faction: Faction | null;
  color: string;
  isDisputed: boolean;
  disputedFactionIds: string[];
  isCapital: boolean;
  capitalLevel: number;
  resolutionStatus: FactionAffiliationPair['resolutionStatus'] | 'unknown';
  factionKey: string;
}

export function resolveFactionRenderStyle(options: {
  systemId?: string;
  eraIndex?: number;
  factionKey?: string;
  factionMap: Record<string, Faction>;
  pairs?: Map<string, FactionAffiliationPair>;
}): FactionRenderStyle {
  const { systemId, eraIndex, factionKey: rawKey, factionMap, pairs } = options;

  if (systemId !== undefined && eraIndex !== undefined) {
    const pair = pairs?.get(`${systemId}_${eraIndex}`) || getFactionAffiliationPair(systemId, eraIndex);
    if (pair) {
      const disputed = pair.normalizedAffiliation.startsWith('D-') || pair.normalizedAffiliation === 'D';
      const disputedFactionIds = disputed
        ? pair.normalizedAffiliation.replace(/^D-?/, '').split('-').filter(Boolean)
        : [];
      return {
        faction: pair.faction,
        color: pair.faction?.color || '#999999',
        isDisputed: disputed,
        disputedFactionIds,
        isCapital: false,
        capitalLevel: 0,
        resolutionStatus: pair.resolutionStatus,
        factionKey: pair.normalizedAffiliation,
      };
    }
  }

  const key = rawKey || '';
  const upperKey = key.toUpperCase();
  const isDisputed = key.startsWith('D-') || key === 'D';
  const disputedFactionIds = isDisputed ? key.replace(/^D-?/, '').split('-').filter(Boolean) : [];

  const faction = (factionMap[key] || factionMap[upperKey] || null);

  return {
    faction,
    color: faction?.color || '#999999',
    isDisputed,
    disputedFactionIds,
    isCapital: false,
    capitalLevel: 0,
    resolutionStatus: 'unknown',
    factionKey: key,
  };
}
