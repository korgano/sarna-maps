import { Era, System } from '../types';
import { extractBorderStateAffiliation } from './extract-border-state-affiliation';
import { getAbandonedBorderFaction, isAbandonedAffiliation } from './abandoned-affiliation';

export function getMapBounds(
  era: Era,
  systems: System[],
  factionIds: string[],
  padding: { x: number; y: number }
) {
  const bounds = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
  };
  const lowerCaseFactionIds = factionIds.map((id) => id.toLowerCase());

  const displayedSystems = systems.filter((system) => {
    if (system.eraAffiliations.length <= era.index) {
      return false;
    }
    const rawAffiliation = system.eraAffiliations[era.index];
    // A(<FACTION>) counts toward <FACTION>'s frame; bare A is excluded (default ignore list)
    const factionId = (isAbandonedAffiliation(rawAffiliation)
      ? getAbandonedBorderFaction(rawAffiliation)
      : extractBorderStateAffiliation(rawAffiliation)
    ).toLowerCase();
    return lowerCaseFactionIds.includes(factionId);
  });
  console.log('displayedSystems', lowerCaseFactionIds, displayedSystems.length);
  displayedSystems.forEach((system) => {
    bounds.minX = Math.min(bounds.minX, system.x);
    bounds.maxX = Math.max(bounds.maxX, system.x);
    bounds.minY = Math.min(bounds.minY, system.y);
    bounds.maxY = Math.max(bounds.maxY, system.y);
  });
  return {
    minX: bounds.minX - padding.x,
    maxX: bounds.maxX + padding.x,
    minY: bounds.minY - padding.y,
    maxY: bounds.maxY + padding.y,
  };
}
