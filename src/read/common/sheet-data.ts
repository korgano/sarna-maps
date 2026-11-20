import { Era, Faction, System } from '../../common';
import { FactionAffiliationPair } from './retain-faction-affiliation-pairing';

export interface SheetData {
  eras: Era[];
  factions: Faction[];
  systems: System[];
  /**
   * System x era affiliation pairs, built once in the read pipeline by
   * `buildFactionAffiliationPairs` (stage 3) and threaded to the renderer —
   * the renderer no longer rebuilds them per image.
   */
  pairs: Map<string, FactionAffiliationPair>;
}
