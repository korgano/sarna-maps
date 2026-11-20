import { Era, FactionRegistry, System } from '../../common';
import { getAbandonedBorderFaction } from '../../common/utils/abandoned-affiliation';
import { traceFaction } from '../../common/utils/faction-traversal-logger';
import { setCacheEntry } from './retain-faction-affiliation-pairing';

const FILE_NAME = 'parse-systems-v3-csv.ts';

export interface ParsedYearCell {
  /** First hierarchy token — the faction (or `A`/`U`/`D` state marker). */
  nation: string;
  /** Parenthetical content of the first token (`A(CFG)` -> `CFG`). */
  attribute: string;
  /** Second hierarchy token (district level). Parsed but NOT currently used in map generation — reserved for future hierarchy levels. */
  district: string;
  /** Third hierarchy token (region level). Parsed but NOT currently used in map generation — reserved for future hierarchy levels. */
  region: string;
  /** Fourth hierarchy token (zone level). Parsed but NOT currently used in map generation — reserved for future hierarchy levels. */
  zone: string;
  /** Fifth hierarchy token (capital qualifier). Parsed but NOT currently used in map generation — reserved for future hierarchy levels. */
  capital: string;
}

export interface EnrichmentOptions {
  factionRegistry?: FactionRegistry;
  visibilityOverride?: { hideAbandoned?: boolean; hideUndiscovered?: boolean };
}

/**
 * Splits an era cell into its hierarchy tokens. v3 separates tokens with
 * `|`, v1 with `,`; separators *inside* parentheses (`D(LC,DC)`) belong to
 * the token, not the hierarchy, so the split is paren-aware.
 */
function splitHierarchy(cell: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;

  for (const char of cell) {
    if (char === '(') depth++;
    else if (char === ')') depth = Math.max(0, depth - 1);

    if ((char === '|' || char === ',') && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current.trim());

  return parts.filter((part) => part !== '');
}

/**
 * Parses one era cell into its hierarchy vocabulary. Handles both source
 * dialects: v3 (`CJF|Tamar Pact|Tamar Domains`, `A(CFG)`, `D(CJF/LC)`) and
 * v1 (`FS,Crucis March,New Avalon`, `D(LC,DC)`).
 *
 * NOTE: this reads the FIRST token only. The border-seeding affiliation —
 * which must keep the full tail for multi-level borders — is computed
 * separately by `borderSeedingAffiliation`.
 */
export function parseYearCell(cell: string): ParsedYearCell {
  const emptyResult: ParsedYearCell = { nation: '', attribute: '', district: '', region: '', zone: '', capital: '' };
  if (!cell || cell.trim() === '') return emptyResult;

  const parts = splitHierarchy(cell);
  if (parts.length === 0) return emptyResult;

  const pos1 = parts[0];
  const district = parts[1] || '';
  const region = parts[2] || '';
  const zone = parts[3] || '';
  const capital = parts[4] || '';

  let nation = pos1;
  let attribute = '';

  const parenMatch = pos1.match(/^([A-Za-z0-9]+)\(([^)]+)\)$/);
  if (parenMatch) {
    nation = parenMatch[1];
    attribute = parenMatch[2];
  }

  return { nation, attribute, district, region, zone, capital };
}

/**
 * The affiliation a system seeds the Voronoi/border computation with: the raw
 * cell with a leading `A(<FACTION>)` unwrapped to `<FACTION>`, so an abandoned
 * system joins its faction's borders (bare `A` and hidden `A(H)` stay as
 * written — they are filtered out downstream).
 *
 * The hierarchy tail after the first token is preserved verbatim:
 * multi-level border configs read level-2/3 affiliations off
 * `point.affiliation`, and a bare faction key would collapse them.
 */
export function borderSeedingAffiliation(raw: string): string {
  const cell = raw.trim();
  if (!getAbandonedBorderFaction(cell)) return cell;
  return cell.replace(/^A\s*\(([^)]+)\)/i, '$1');
}

/** Visibility of a system's dot for a cell, given optional config overrides. */
export function computeVisibility(
  nation: string,
  visibilityOverride: { hideAbandoned?: boolean; hideUndiscovered?: boolean },
): boolean {
  if (nation === 'A' && visibilityOverride.hideAbandoned) return false;
  if (nation === 'U' && visibilityOverride.hideUndiscovered) return false;
  return true;
}

/** Resolves a faction's color for a nation key; unknown factions get black. */
export function resolveFactionColor(nation: string, factions: FactionRegistry): string {
  const faction = factions.get(nation);
  return (faction && faction.color) ? faction.color : '#000000';
}

/**
 * Stage 2 of the read pipeline: enrichment.
 *
 * Walks every system x era of the already-ingested `System[]` (stage 1,
 * `parseSystems`) and records the derived per-cell values — border-seeding
 * affiliation, faction color, visibility, attribute — into the enrichment
 * cache. Stage 3 (`buildFactionAffiliationPairs`) and the Voronoi pass read
 * them back through `getCacheEntry*`.
 *
 * DATA FLOW (read → compute → render):
 *   1. parseSystems (stage 1) stores raw era cells in System.eraAffiliations[]
 *   2. parseSystemsV3Csv (stage 2, this function) reads each raw cell, derives
 *      nation/borderID/factionColor/visible/attribute, and caches them by
 *      "${system.id}_${era.index}"
 *   3. buildFactionAffiliationPairs (stage 3) reads the cache into each
 *      FactionAffiliationPair, returned in SheetData.pairs
 *   4. calculateVoronoiBorders (compute) reads getCacheEntryBorderID() to seed
 *      Voronoi points — A(<FACTION>) systems seed as <FACTION>, bare A is
 *      filtered out
 *   5. renderMapLayer (render) reads getCacheEntryBorderID() for systemsByFaction
 *      grouping, so render and compute agree on faction membership
 *
 * Runs for every source (v3 export, legacy CSV, Google Sheets): the cell
 * vocabulary is shared, so one pass suffices.
 *
 * Output-neutral by construction: with an empty cache today the Voronoi falls
 * back to the raw era cell, so `borderID` here reproduces exactly that (raw
 * cell, `A(F)` unwrapped, tail preserved) and `visible` defaults to true (no
 * `visibilityOverride` config exists).
 *
 * @param systems Systems from stage 1 (era cells stored raw)
 * @param eras All eras of the read — enrichment covers every system x era
 * @param options Optional faction registry (for colors) and visibility overrides
 * @returns The same systems array, for chaining
 */
export function parseSystemsV3Csv(
  systems: Array<System>,
  eras: Array<Era>,
  options: EnrichmentOptions = {},
): Array<System> {
  const factionRegistry = options.factionRegistry ?? new FactionRegistry();
  const visibilityOverride = options.visibilityOverride ?? {};

  let entries = 0;
  for (const system of systems) {
    for (const era of eras) {
      const raw = (system.eraAffiliations?.[era.index] || '').trim();
      const parsed = parseYearCell(raw);

      setCacheEntry(`${system.id}_${era.index}`, {
        nation: parsed.nation,
        borderID: borderSeedingAffiliation(raw),
        factionColor: resolveFactionColor(parsed.nation, factionRegistry),
        visible: computeVisibility(parsed.nation, visibilityOverride),
        attribute: parsed.attribute,
      });
      entries++;
    }
  }

  traceFaction(FILE_NAME, 'enrich', `systems=${systems.length}, eras=${eras.length}, entries=${entries}`);
  return systems;
}
