import xlsx, { WorkSheet } from 'node-xlsx';
import fs from 'fs';
import { parseEras, parseFactions, parseSystems } from './common';
import { DataSourceConfig } from '../common';
import { traceFaction } from '../common/utils/faction-traversal-logger';

export function readFromXlsxFile(path: string, dataSourceConfig: DataSourceConfig) {
  const worksheets = xlsx.parse(fs.readFileSync(path)) as Array<WorkSheet>;

  const eras = parseEras(worksheets[dataSourceConfig.sheetIndices.columns].data as unknown as Array<Array<string>>);

  const factionsSheet = worksheets[dataSourceConfig.sheetIndices.factions].data as unknown as Array<Array<string>>;

  //0 = First Column
  const factionColumnIndex = 0;

  for (const row of factionsSheet) {
    const faction = row[factionColumnIndex];
    traceFaction('src/read/xlsx-reader.ts', 'read-xlsx', faction);
  }

  const factions = parseFactions(factionsSheet);

  const systems = parseSystems(
    worksheets[dataSourceConfig.sheetIndices.systems].data as unknown as Array<Array<string>>, eras
  );

  return {
    eras,
    factions,
    systems
  };
}