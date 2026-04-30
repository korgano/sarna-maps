import { Faction, logger, Point2d, pointOnUnitCircleByPercentValue } from '../../../common';
import { traceFaction } from '../../../common/utils/faction-traversal-logger';
import { FactionRenderStyle } from '../types/faction-render-style';

const FILE_NAME = 'generate-disputed-system-fill-pattern.ts';

export function generateDisputedSystemFillPattern(
  factionKey: string,
  factions: Record<string, Faction>,
  prefix = '',
  style?: FactionRenderStyle,
) {
  traceFaction(FILE_NAME, 'INPUT factionKey', factionKey);

  const factionKeys = factionKey.replace(/^D-/i, '').split('-');

  traceFaction(FILE_NAME, 'PARSED factionKeys', JSON.stringify(factionKeys));

  if (factionKeys.length < 2) {
    logger.warn(
      'generate-disputed-system-fill-pattern.ts',
      `Cannot create disputed system fill pattern: Need at least two factions in key "${factionKey}"`
    );
    traceFaction(FILE_NAME, 'INVALID factionKeys LENGTH', factionKey);
    return '';
  }

  const paths: Array<string> = [];

  let currentPercentage = 0;
  let startPoint: Point2d;
  let endPoint: Point2d;

  const percentageForEachSlice = 1 / factionKeys.length;

  traceFaction(
    FILE_NAME,
    'SLICE PERCENTAGE',
    `count=${factionKeys.length} percentage=${percentageForEachSlice}`
  );

  for (let i = 0; i < factionKeys.length; i++) {
    const key = factionKeys[i];
    const faction = factions[key];

    traceFaction(FILE_NAME, `ITERATION ${i}`, `key="${key}"`);

    // Use style's disputedFactionIds if available, otherwise fall back to faction lookup
    let color = '#000';
    if (style?.disputedFactionIds?.length) {
      const disputedFaction = factions[style.disputedFactionIds[i]] || faction;
      color = disputedFaction?.color || '#000';
    } else if (faction) {
      color = faction.color || '#000';
    }

    if (!faction && !style?.disputedFactionIds?.length) {
      // 🔴 ROOT CAUSE FIX: prevent crash + log missing mapping
      logger.error(
        'generate-disputed-system-fill-pattern.ts',
        `Missing faction definition for key "${key}" in disputed pattern "${factionKey}"`
      );

      traceFaction(
        FILE_NAME,
        'MISSING FACTION',
        `key="${key}" factionKey="${factionKey}"`
      );

      // Fallback: render slice in black to preserve geometry
      startPoint = pointOnUnitCircleByPercentValue(currentPercentage);
      currentPercentage += percentageForEachSlice;
      endPoint = pointOnUnitCircleByPercentValue(currentPercentage);

      paths.push(
        `<path d="` +
          `M${startPoint.x},${startPoint.y} ` +
          `A1,1,0,0,1,${endPoint.x},${endPoint.y} ` +
          `L0,0" ` +
          `style="fill:#000; stroke-width: 0;" />`
      );

      continue;
    }

    traceFaction(
      FILE_NAME,
      'FACTION RESOLVED',
      `key="${key}" color="${color}"`
    );

    startPoint = pointOnUnitCircleByPercentValue(currentPercentage);
    currentPercentage += percentageForEachSlice;
    endPoint = pointOnUnitCircleByPercentValue(currentPercentage);

    paths.push(
      `<path d="` +
        `M${startPoint.x},${startPoint.y} ` +
        `A1,1,0,0,1,${endPoint.x},${endPoint.y} ` +
        `L0,0" ` +
        `style="fill:${color}; stroke-width: 0;" />`
    );
  }

  const patternId = `${prefix}system-fill-${factionKey}`;

  traceFaction(FILE_NAME, 'FINAL PATTERN ID', patternId);

  return (
    `<pattern id="${patternId}" width="1" height="1" viewBox="-1 -1 2 2">` +
    `<g style="transform:rotate(-90deg)">${paths.join('')}</g></pattern>`
  );
}