import { Faction, FactionRegistry, logger, Point2d, pointOnUnitCircleByPercentValue } from '../../../common';
import { sanitizeFactionToken } from './sanitize-faction-token';

export function generateDisputedSystemFillPattern(factionKey: string, factionRegistry: FactionRegistry, prefix = '') {
  const factionKeys = factionKey.replace(/^D[(]([^)]+)[)]$/i, '$1').replace(/^D-/i, '').split(/[-|/]/).filter(Boolean);
  if (factionKeys.length < 2) {
    logger.warn(`Cannot create disputed system fill pattern: Need at least two factions in key "${factionKey}"`);
    return '';
  }
  const safeKey = sanitizeFactionToken(factionKey);
  const paths: Array<string> = [];
  let faction: Faction;
  let currentPercentage = 0;
  let startPoint: Point2d;
  let endPoint: Point2d;
  const percentageForEachSlice = 1 / factionKeys.length;

  for (let i = 0; i < factionKeys.length; i++) {
    faction = factionRegistry.get(factionKeys[i]) as Faction;
    startPoint = pointOnUnitCircleByPercentValue(currentPercentage);
    currentPercentage += percentageForEachSlice;
    endPoint = pointOnUnitCircleByPercentValue(currentPercentage);
    paths.push(`<path d="`+
      `M${startPoint.x},${startPoint.y} ` +
      `A1,1,0,0,1,${endPoint.x},${endPoint.y} ` +
      `L0,0" ` +
      `style="fill="${faction.color || '#000'}"; stroke-width: 0;" />`);
  }
  return `<pattern id="${prefix}system-fill-${safeKey}" width="1" height="1" viewBox="-1 -1 2 2">` +
    `<g style="transform:rotate(-90deg)">${paths.join('')}</g></pattern>`;
}
