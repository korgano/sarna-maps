import { Faction, logger } from '../../common';
import { traceFaction } from '../../common/utils/faction-traversal-logger';

/**
 * Assumptions:
 * - The sheet's first row contains the headers
 * - There are columns named "factionid", "factionname", "color", "startyear", "endyear" and "sarnalink" (case-insensitive)
 * - The colors are recorded in RGB hex format with a prefixed # symbol (e.g. #A55EA6)
 * TODO all of these assumptions belong in a config file
 *
 * @param rows The data rows, with the rows as the first and the column/cells as the second dimension
 */
export function parseFactions(rows: Array<Array<string>>): Array<Faction> {
  logger.info(`Reading factions ...`);
  const factions: Array<Faction> = [];

  /**if (!rows || !(rows || []).length) {
    logger.info('Faction sheet empty, no factions read.');
    return factions;
  }*/
 if (!rows || rows.length === 0) {
  logger.info(`Faction sheet empty, no factions read.`);
  return factions;
 }

  // headers: map column titles (lowercase) to column index
  const columnIndexMap: Record<string, number> = {};
  /**rows[0].forEach((columnName, columnIndex) => {
    columnIndexMap[(columnName + '').toLowerCase()] = columnIndex;
  });*/
  rows[0].forEach((columnName, columnIndex) => {
    const key = (columnName ?? '').toString().toLowerCase();
    columnIndexMap[key] = columnIndex;
  });

  // read factions
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];

    const rawId = row[columnIndexMap['factionId']] ?? '';
    if (!rawId) {
      // no ID -> nothing to do
      continue;
    }

    traceFaction('src/read/common/parse-factions.ts', 'raw-input', rawId);

    const normalizedId = rawId.toString();

    const name = row[columnIndexMap['factionname']] ?? '';
    const color = row[columnIndexMap['color']] ?? '';
    const foundingRaw = row[columnIndexMap['startyear']] ?? '';
    const dissolutionRaw = row[columnIndexMap['endyear']] ?? '';

    const founding = parseInt(foundingRaw, 10);
    const dissolution = parseInt(dissolutionRaw, 10);

    const faction: Faction = {
      id: normalizedId,
      name,
      color,
      founding: !isNaN(founding) ? founding : undefined,
      dissolution: !isNaN(dissolution) ? dissolution : undefined,
    }

    traceFaction('src/read/common/parse-factions.ts', 'normalized', normalizedId);

    factions.push(faction);

  }

  factions.forEach((faction) => {
    traceFaction('src/read/common/parse-factions.ts', 'final-output', faction.id);
    traceFaction('src/read/common/parse-factions.ts', 'REGISTERED FACTION', faction.id);
  });
    // skip factions without an ID
  /**  if (!row[columnIndexMap['factionid']]) {
      continue;
    }

    // parse faction data
    const founding = parseInt(row[columnIndexMap ['startyear']] + '', 10);
    const dissolution = parseInt(row[columnIndexMap['endyear']] + '', 10);
    factions.push({
      id: row[columnIndexMap['factionid']] + '',
      name: row[columnIndexMap['factionname']] + '',
      color: row[columnIndexMap['color']] + '',
      founding: !isNaN(founding) ? founding : undefined,
      dissolution: !isNaN(dissolution) ? dissolution : undefined,
    });
  }*/

  logger.info(`${factions.length} factions read.`);
  return factions;
}
