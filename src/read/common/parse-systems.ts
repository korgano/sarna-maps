import { parseSingleSystem, SystemRow } from './parse-single-system';
import { Era, logger, System } from '../../common';
import { traceFaction } from '../../common/utils/faction-traversal-logger';

/**
 * The single ingestion stage of the read pipeline (stage 1 of 3):
 *
 *   `parseSystems` -> `parseSystemsV3Csv` (enrichment) -> `buildFactionAffiliationPairs`
 *
 * Every spreadsheet source (v3 TrollMaster CSV, legacy CSV, Google Sheets) is
 * fed through this one function, which understands both layouts:
 *
 * - **v3 export** — header on row 0, metadata columns `systemID`, `systemName`,
 *   `x`, `y`, `size`, then era columns named by year (`2271`, `3050a`, ...).
 * - **v1 sheet** — header on row 0 or row 1 (a blank/title row may precede it),
 *   metadata in columns A..H, era columns addressed positionally as `era_N`
 *   starting at column I, with a literal `era_N` header name accepted too.
 *
 * The header row is located by content rather than by a fixed index, so the
 * same call works for `parseMatrix` output (header first), for
 * `convertToMatrixFormat` output (header first), and for sheets that keep a
 * title row above the header.
 *
 * **Era cells are stored RAW** (trimmed; empty -> `U`). Downstream parses the
 * cell itself and needs the untouched string to do so: `parseSingleSystem`
 * reads the last token to detect capital levels, `extractBorderStateAffiliation`
 * walks the hierarchy, `normalizeFactionKey` collapses keys for pairing, and
 * hidden-marker detection looks for a `(H)` suffix that normalisation strips.
 * Normalising here would destroy all of that.
 *
 * TODO the column layout belongs in a config file.
 *
 * @param rows The data rows, with the rows as the first and the column/cells as the second dimension
 * @param eras The previously parsed eras array
 * @param sourceName Human-readable source identifier used in diagnostics
 *   (e.g. the systems CSV path). Defaults to 'systems'.
 * @returns The parsed systems, sorted so that clusters paint first
 */
export function parseSystems(
  rows: Array<Array<string>>,
  eras: Array<Era>,
  sourceName = 'systems',
): Array<System> {
  const systems: Array<System> = [];

  logger.info('Reading systems ...');

  if (!rows || !(rows || []).length) {
    logger.info('Systems sheet empty, no factions read.');
    return [] as Array<System>;
  }

  const header = locateHeader(rows);
  const columnIndexMap = header.columnIndexMap;

  let eraCount = 0;
  while (columnIndexMap['era_' + eraCount] !== undefined) eraCount++;
  const firstEraCol = columnIndexMap['era_0'];
  const lastEraCol = columnIndexMap['era_' + (eraCount - 1)];
  traceFaction('src/read/common/parse-systems.ts', 'era-columns-detected',
    `count=${eraCount}, first=${firstEraCol}, last=${lastEraCol}, expectedEras=${eras.length}`);

  if (eraCount !== eras.length) {
    warnOnEraColumnMismatch(header, eraCount, eras, sourceName);
  }

  const cellAt = (row: Array<string>, columnKey: string): string => {
    const column = columnIndexMap[columnKey];
    if (column === undefined) return '';
    const value = row[column];
    return value === undefined || value === null ? '' : String(value);
  };

  for (let rowIndex = header.rowIndex + 1; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    if (!row) continue;

    const x = parseCoordinate(cellAt(row, 'x'));
    const y = parseCoordinate(cellAt(row, 'y'));

    // skip systems without coordinates
    if (x === null || y === null) {
      continue;
    }

    const rowToParse: SystemRow = {
      id: cellAt(row, 'id'),
      name: cellAt(row, 'systemname'),
      alternateNames: cellAt(row, 'alternatename'),
      x,
      y,
      size: parseSizeCell(cellAt(row, 'size')),
      eraAffiliations: eras.map((_, eraIndex) => cellAt(row, 'era_' + eraIndex).trim() || 'U'),
    };

    systems.push(parseSingleSystem('system-' + rowIndex, rowToParse, eras));
  }

  // sort systems so that clusters are painted first and appear at the bottom (visually)
  systems.sort((a, b) => (b.radiusX + b.radiusY) - (a.radiusX + a.radiusY));

  logger.info(`${systems.length} systems read.`);
  return systems;
}

/** Columns that identify a systems header row, matched case-insensitively. */
const HEADER_MARKER_COLUMNS = ['id', 'systemid', 'systemname', 'alternatename', 'x', 'y', 'size'];
/** How many of the leading rows are inspected before falling back to row 1. */
const HEADER_SCAN_ROWS = 4;
const HEADER_MARKER_MIN_HITS = 3;

/** v1 sheets keep metadata in columns A..H, so era columns start at column I. */
const V1_FIRST_ERA_COLUMN_INDEX = 8;

/** v3 names its era columns by year, optionally suffixed with a variant letter. */
const YEAR_COLUMN_REGEX = /^\d{4}([a-z])?$/;

interface SystemsHeader {
  /** Index of the header row inside `rows`. */
  rowIndex: number;
  headerRow: Array<string>;
  /**
   * Lowercased header cell -> column index. Era columns are keyed `era_N`
   * regardless of how they are named in the sheet, so the row reader can map
   * `eras[N]` to a column without knowing the layout.
   */
  columnIndexMap: Record<string, number>;
  /** True when era columns are named by year (v3 export) instead of `era_N`. */
  yearNamedEras: boolean;
}

function headerKey(raw: unknown): string {
  return String(raw ?? '').trim().toLowerCase();
}

/**
 * Finds the header row and builds the column map for the layout that row
 * describes. Rows are scanned by content (several known column names must be
 * present) so a blank/title row above the header is skipped and a data row is
 * never mistaken for the header.
 */
function locateHeader(rows: Array<Array<string>>): SystemsHeader {
  let rowIndex = -1;
  const scanLimit = Math.min(HEADER_SCAN_ROWS, rows.length);

  for (let i = 0; i < scanLimit; i++) {
    const markerHits = (rows[i] || [])
      .map(headerKey)
      .filter((cell) => HEADER_MARKER_COLUMNS.includes(cell)).length;
    if (markerHits >= HEADER_MARKER_MIN_HITS) {
      rowIndex = i;
      break;
    }
  }

  // Fall back to the historical v1 layout (header on the second row).
  if (rowIndex < 0) {
    rowIndex = rows.length > 1 ? 1 : 0;
  }

  const headerRow = (rows[rowIndex] || []).map((cell) => String(cell ?? ''));
  const yearNamedEras = headerRow.some((cell) => YEAR_COLUMN_REGEX.test(headerKey(cell)));
  const columnIndexMap: Record<string, number> = {};

  if (yearNamedEras) {
    // v3: metadata resolved by header name, era columns taken in header order.
    headerRow.forEach((cell, index) => {
      const key = headerKey(cell);
      if (key) columnIndexMap[key] = index;
    });
    const eraColumns: Array<number> = [];
    headerRow.forEach((cell, index) => {
      if (YEAR_COLUMN_REGEX.test(headerKey(cell))) eraColumns.push(index);
    });
    eraColumns.forEach((column, eraIndex) => {
      columnIndexMap['era_' + eraIndex] = column;
    });
  } else {
    // v1: metadata resolved by header name across columns A..H, then `era_N`
    // addressed positionally from column I onwards.
    headerRow.forEach((cell, index) => {
      const key = headerKey(cell);
      if (index < V1_FIRST_ERA_COLUMN_INDEX) {
        if (key) columnIndexMap[key] = index;
      } else {
        columnIndexMap['era_' + (index - V1_FIRST_ERA_COLUMN_INDEX)] = index;
      }
    });
  }

  // The v3 export calls the identifier column `systemID`; `SystemRow` calls it `id`.
  if (columnIndexMap['id'] === undefined && columnIndexMap['systemid'] !== undefined) {
    columnIndexMap['id'] = columnIndexMap['systemid'];
  }

  return { rowIndex, headerRow, columnIndexMap, yearNamedEras };
}

/**
 * Reports an era-column / era-list mismatch with enough detail to fix it:
 * rows are mapped positionally (era column N -> eras[N]), so a count mismatch
 * means affiliations land on the wrong eras for whole maps.
 */
function warnOnEraColumnMismatch(
  header: SystemsHeader,
  eraCount: number,
  eras: Array<Era>,
  sourceName: string,
): void {
  const headerAt = (eraIndex: number): string => {
    const column = header.columnIndexMap['era_' + eraIndex];
    return column === undefined ? '' : String(header.headerRow[column] ?? '');
  };

  const firstHeader = headerAt(0);
  const lastHeader = headerAt(eraCount - 1);
  const firstEra = eras.length > 0 ? `${eras[0].year} (${eras[0].name})` : 'none';
  const lastEra = eras.length > 0 ? `${eras[eras.length - 1].year} (${eras[eras.length - 1].name})` : 'none';

  let firstDivergence = 'n/a';
  const sharedCount = Math.min(eraCount, eras.length);
  for (let i = 0; i < sharedCount; i++) {
    if (headerAt(i).trim() !== String(eras[i].year)) {
      firstDivergence = `era #${i} header "${headerAt(i).trim()}" vs parsed era #${i} year ${eras[i].year}`;
      break;
    }
  }
  if (firstDivergence === 'n/a') {
    firstDivergence = eraCount > eras.length
      ? `extra trailing column(s) after era #${sharedCount - 1} header "${headerAt(sharedCount)}" (no matching parsed era; these affiliations are dropped)`
      : `missing trailing column(s): parsed eras continue with #${sharedCount} year ${eras[sharedCount]?.year} (systems get no affiliation there)`;
  }

  logger.warn(
    'parse-systems.ts',
    `Era column count (${eraCount}) does not match parsed eras (${eras.length}, "${firstEra}".."${lastEra}") in source "${sourceName}". ` +
    `Headers "${firstHeader}".."${lastHeader}". First divergence: ${firstDivergence}. ` +
    `Rows are parsed positionally, so affiliations shift eras — check the description CSV/sheet era list against the systems sheet columns.`,
  );
}

/** Coordinates accept both `10`/`-123.764` styles; blank/non-numeric means "no position". */
function parseCoordinate(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Parses a `size` cell into scale/rotation. v1 separates with commas
 * (`1,1,0`), v3 with pipes (`1|1|0`), so both dividers are accepted.
 */
function parseSizeCell(value: string): [number, number, number] {
  const trimmed = value.trim();
  if (!trimmed) return [1, 1, 0];

  const parts = trimmed
    .split(/[,|]/)
    .map((part) => parseFloat(part.trim()))
    .filter((part) => !isNaN(part));

  if (parts.length < 2) return [1, 1, 0];
  return [parts[0], parts[1], parts[2] ?? 0];
}
