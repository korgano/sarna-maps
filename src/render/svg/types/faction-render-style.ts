import { Faction, FactionRegistry } from '../../../common';
import { FactionAffiliationPair } from '../../../read/common/retain-faction-affiliation-pairing';
import { getFactionAffiliationPair } from '../../../read/common/retain-faction-affiliation-pairing';
import { isDisputedAffiliation, parseDisputedSubFactions } from '../../../common/utils/disputed-affiliation';
import { sanitizeCssColor } from '../../../common/utils/sanitize-css-color';

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
  factionRegistry: FactionRegistry;
  pairs?: Map<string, FactionAffiliationPair>;
}): FactionRenderStyle {
  const { systemId, eraIndex, factionKey: rawKey, factionRegistry, pairs } = options;

  if (systemId !== undefined && eraIndex !== undefined) {
    const pair = pairs?.get(`${systemId}_${eraIndex}`) || getFactionAffiliationPair(systemId, eraIndex);
    if (pair) {
      const disputed = pair.normalizedAffiliation.startsWith('D-') || pair.normalizedAffiliation === 'D';
      const disputedFactionIds = disputed
        ? pair.normalizedAffiliation.replace(/^D-?/, '').split('-').filter(Boolean)
        : [];
      return {
        faction: pair.faction,
        color: sanitizeCssColor(pair.faction?.color || '#999999'),
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
  const isDisputed = isDisputedAffiliation(key);
  const disputedFactionIds: string[] = isDisputed ? parseDisputedSubFactions(key) : [];

  // Case-insensitive lookup via FactionRegistry — handles AuC/AUC/aUc,
  // abandoned-world wrapper A(FACTION) → inner faction, all in one place.
  const faction = isDisputed ? null : factionRegistry.get(key);

  return {
    faction,
    color: sanitizeCssColor(faction?.color || '#999999'),
    isDisputed,
    disputedFactionIds,
    isCapital: false,
    capitalLevel: 0,
    resolutionStatus: 'unknown',
    factionKey: key,
  };
}
