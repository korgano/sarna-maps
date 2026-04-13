import { traceFaction } from '../../common/utils/faction-traversal-logger';
import { getFactionAffiliationPair } from '../../read/common/retain-faction-affiliation-pairing';

const FILE_NAME = 'extract-border-state-affiliation.ts';

const BORDER_STATE_REGEX = /^([A-Za-z0-9\-]+)\s*(\(([^)]+)\))?/i;

/**
 * Extracts the main border state affiliation from a full affiliation string
 */
export function extractBorderStateAffiliation(
  fullAffiliation: string,
  ignoredAffiliations = ['', 'A', 'U'],
  parseHiddenSystemsAs: 'ignore' | 'faction' | 'full' = 'ignore',
  levels = 1,
  removeCapitalTokens = false,

  // ✅ NEW (optional, non-breaking)
  systemId?: string,
  eraIndex?: number,
) {

  if (removeCapitalTokens) {
    fullAffiliation = fullAffiliation.replace(/,(faction|minor|major)\s+capital/ig, '');
  }

  const match = (fullAffiliation || '').trim().match(BORDER_STATE_REGEX) || [];
  const [, stateAff, , additionalAff] = match;

  const result: Array<string> = [];

  // --- Decision Branches ---
  if (
    ignoredAffiliations.includes(stateAff) ||
    (additionalAff === 'H' && parseHiddenSystemsAs === 'ignore')
  ) {
    result.push('');
  } else if (stateAff === 'D') {
    if (additionalAff) {
      const combined = [stateAff, ...additionalAff.split(',')].join('-');
      traceFaction(FILE_NAME, 'DISPUTED COMBINED', combined);
      result.push(combined);
    } else {
      result.push(stateAff);
    }
  } else if (additionalAff === 'H') {
    const value =
      parseHiddenSystemsAs === 'faction'
        ? stateAff
        : stateAff + '(H)';

    result.push(value);
  } else if (additionalAff) {
    result.push(additionalAff);
  } else {
    result.push(stateAff);
  }

  // --- Additional Levels ---
  const remaining = fullAffiliation.replace(BORDER_STATE_REGEX, '');
  const allAffiliations = remaining.split(',');

  for (let currentLevel = 1; currentLevel < levels; currentLevel++) {
    if (allAffiliations.length > currentLevel) {
      const levelValue = allAffiliations[currentLevel];
      result.push(levelValue);
    }
  }

  let finalResult = result.join(',');

  /**
   * ✅ NEW: Pairing integration (non-breaking)
   * - Only applies if systemId + eraIndex are provided
   * - Overrides affiliation with normalized pairing when available
   */
  if (systemId !== undefined && eraIndex !== undefined) {
    const pair = getFactionAffiliationPair(systemId, eraIndex);

    if (pair) {
      traceFaction(
        FILE_NAME,
        'PAIRING LOOKUP',
        `${systemId}_${eraIndex}:${pair.normalizedAffiliation}:${pair.faction ? pair.faction.id : 'NULL'}:${pair.resolutionStatus}`
      );

      // Only override if normalization changed something meaningful
      if (pair.normalizedAffiliation && pair.normalizedAffiliation !== finalResult) {
        traceFaction(
          FILE_NAME,
          'PAIRING OVERRIDE',
          `${finalResult} -> ${pair.normalizedAffiliation}`
        );

        finalResult = pair.normalizedAffiliation;
      }
    } else {
      traceFaction(
        FILE_NAME,
        'PAIRING MISSING',
        `${systemId}_${eraIndex}`
      );
    }
  }

  traceFaction(FILE_NAME, 'FINAL RESULT', finalResult);

  return finalResult;
}