import { BorderEdgeLoop } from '../types';
import { System } from '../../../common';
import { polygonContains } from '../../../common/math-2d/polygon-contains';
import { logger } from '../../../common';
import { traceFaction } from '../../../common/utils/faction-traversal-logger';
import { normalizeFactionKey } from '../../../common/utils/normalize-faction-key';
import { isDisputedAffiliation, parseDisputedSubFactions } from '../../../common/utils/disputed-affiliation';
import { EMPTY_FACTION, INDEPENDENT } from '../../constants';

/**
 * Normalized ownership match between a containing loop faction and a system's
 * top-level affiliation. Handles separator drift between raw system keys
 * (`D(LC/DC)`) and normalized loop keys (`D-LC-DC`) by comparing normalized
 * forms, plus disputed overlap: a system belongs in a disputed zone when they
 * share at least one sub-faction, and a member-faction system belongs inside
 * its disputed zone (and vice versa).
 */
function ownsSystem(loopFaction: string, systemTopLevel: string): boolean {
  const fNorm = normalizeFactionKey(loopFaction);
  const tNorm = normalizeFactionKey(systemTopLevel);
  if (fNorm === tNorm) return true;
  const fDisputed = isDisputedAffiliation(loopFaction) || isDisputedAffiliation(fNorm);
  const tDisputed = isDisputedAffiliation(systemTopLevel) || isDisputedAffiliation(tNorm);
  if (fDisputed || tDisputed) {
    const fSubs = new Set(parseDisputedSubFactions(fNorm));
    const tSubs = new Set(parseDisputedSubFactions(tNorm));
    // Plain member key on either side matches the other's sub-factions.
    if (fSubs.has(tNorm) || tSubs.has(fNorm)) return true;
    for (const s of fSubs) {
      if (tSubs.has(s)) return true;
    }
  }
  // Legacy substring fallback for hierarchical keys (e.g. `FWL,Marik`).
  return tNorm.includes(fNorm) || fNorm.includes(tNorm);
}

export interface SystemContainmentReport {
  /** Systems checked (excluding irrelevant affiliations). */
  checked: number;
  /** Systems inside at least one wrong faction's polygon. */
  miscontained: number;
  /** Systems inside no polygon of their own faction (or its disputed zones). */
  outsideOwn: number;
  /** Hidden worlds found inside another faction's polygon (expected: they draw no borders). */
  hiddenInsideOther: number;
  /** Independent worlds inside no faction polygon at all (expected: they hold no territory). */
  independentOutsideAll: number;
}

/**
 * True for hidden-system affiliations such as `FWL(H)` — worlds that exist
 * but are suppressed from border generation.
 */
function isHiddenAffiliation(topLevel: string): boolean {
  return /\(H\)/i.test(topLevel);
}

/**
 * True for independent-world affiliations (`I`, bare or with hierarchy).
 * Compared case-insensitively against the INDEPENDENT constant so `i`
 * variants match too.
 */
function isIndependentAffiliation(topLevel: string): boolean {
  const head = topLevel.split('|')[0].trim().toUpperCase();
  return head === INDEPENDENT.toUpperCase();
}

/**
 * Validates that every system is contained within a border loop belonging to
 * its own faction (or a disputed faction it belongs to). Logs warnings for
 * systems that are inside the wrong faction's polygon or outside their own
 * faction's polygon entirely, both of which indicate winding/orientation or
 * gap bugs in the loop generation pipeline.
 *
 * Returns a report so callers and regression tests can assert on containment
 * without parsing log output. Never throws — map generation must not crash
 * on validation findings.
 *
 * @param borderLoops Per-faction border loops (keyed by faction ID)
 * @param systems The full systems list
 * @param eraIndex The era index to check affiliations for
 */
export function validateSystemContainment(
  borderLoops: Record<string, Array<BorderEdgeLoop>>,
  systems: Array<System>,
  eraIndex: number,
): SystemContainmentReport {
  const report: SystemContainmentReport = {
    checked: 0, miscontained: 0, outsideOwn: 0, hiddenInsideOther: 0, independentOutsideAll: 0,
  };

  for (const system of systems) {
    const affiliation = system.eraAffiliations[eraIndex] || '';
    // Extract the top-level faction code, stopping at commas outside parentheses
    // to avoid truncating disputed zone keys like "D(LC,DC)" to just "D(LC".
    // Falls back to the full affiliation if no comma exists outside parens.
    let topLevel = '';
    if (affiliation) {
      let input = affiliation.trim();
      let depth = 0;
      let dividerIndex = -1;
      for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (ch === '(') depth++;
        else if (ch === ')') depth = Math.max(0, depth - 1);
        else if (ch === ',' && depth === 0) {
          dividerIndex = i;
          break;
        }
      }
      if (dividerIndex >= 0) {
        topLevel = input.substring(0, dividerIndex).trim();
      } else {
        topLevel = input;
      }
    }
    if (!topLevel || topLevel === 'U' || topLevel === 'A' || topLevel === '') continue;
    if (!topLevel) continue;
    report.checked++;

    const systemPoint = { x: system.x, y: system.y };

    // Check which faction loops contain this system
    const containingFactions: string[] = [];
    for (const [faction, loops] of Object.entries(borderLoops)) {
      if (faction === EMPTY_FACTION || faction === INDEPENDENT) continue;
      for (const loop of loops) {
        if (!loop.innerAffiliation) continue;
        if (!loop.edges || loop.edges.length < 3) continue;
        const pts = loop.edges.map((e) => e.node1);
        if (polygonContains(pts, systemPoint)) {
          containingFactions.push(faction);
          break;
        }
      }
    }

    // Hidden worlds draw no borders, so containment expectations don't apply:
    // report them as guests inside a separate faction's polygon instead of as
    // "outside their own". Silent when inside nothing at all.
    if (isHiddenAffiliation(topLevel)) {
      if (containingFactions.length > 0) {
        report.hiddenInsideOther++;
        logger.warn(
          'validateSystemContainment',
          `System "${system.name}" (${topLevel}) is a hidden world inside separate faction polygon(s): [${containingFactions.join(', ')}]`,
        );
      }
      continue;
    }

    // Independent worlds hold no territory: report them as outside ALL faction
    // polygons rather than "outside their own". Silent enclaves inside a
    // faction polygon are expected and uninteresting.
    if (isIndependentAffiliation(topLevel)) {
      if (containingFactions.length === 0) {
        report.independentOutsideAll++;
        logger.warn(
          'validateSystemContainment',
          `System "${system.name}" (${topLevel}) is an independent world outside all faction polygons`,
        );
      }
      continue;
    }

    // The system should be contained by its own faction (or a disputed zone containing it)
    const insideOwn = containingFactions.some((f) => ownsSystem(f, topLevel));

    if (containingFactions.length > 0 && !insideOwn) {
      report.miscontained++;
      logger.warn(
        'validateSystemContainment',
        `System "${system.name}" (${topLevel}) is inside wrong faction polygon(s): [${containingFactions.join(', ')}]`,
      );
      traceFaction(
        'validate-system-containment.ts',
        `era-${eraIndex}:miscontained`,
        `${system.name}(${topLevel}) inside [${containingFactions.join(', ')}]`,
        eraIndex,
      );
    }

    if (!insideOwn) {
      report.outsideOwn++;
      logger.warn(
        'validateSystemContainment',
        `System "${system.name}" (${topLevel}) is outside its own faction polygon(s) (inside: [${containingFactions.join(', ') || 'none'}])`,
      );
      traceFaction(
        'validate-system-containment.ts',
        `era-${eraIndex}:outside-own`,
        `${system.name}(${topLevel}) inside [${containingFactions.join(', ') || 'none'}]`,
        eraIndex,
      );
    }
  }

  if (report.miscontained > 0 || report.outsideOwn > 0) {
    logger.warn(
      'validateSystemContainment',
      `${report.miscontained} system(s) inside wrong faction polygons, ${report.outsideOwn} system(s) outside their own faction polygons ` +
      `(hidden inside another faction: ${report.hiddenInsideOther}, independent outside all: ${report.independentOutsideAll}, checked ${report.checked})`,
    );
  } else {
    logger.debug(
      'validateSystemContainment',
      `All ${report.checked} faction systems are inside correct faction polygons ` +
      `(hidden inside another faction: ${report.hiddenInsideOther}, independent outside all: ${report.independentOutsideAll})`,
    );
  }

  return report;
}
