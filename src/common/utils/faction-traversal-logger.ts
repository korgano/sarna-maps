import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

/**
 * Always resolve relative to project root (execution root)
 */
const OUTPUT_PATH = path.resolve(process.cwd(), 'src/faction-traversal-log.txt');

/**
 * Regex for target faction patterns
 */
const TARGET_REGEX = /CIZ[1-3][A-C]/;

/**
 * Ensures log file exists (atomic-safe)
 */
function ensureLogFile(): void {
  try {
    if (!fs.existsSync(OUTPUT_PATH)) {
      fs.writeFileSync(OUTPUT_PATH, '', { encoding: 'utf-8' });
    }
  } catch (err) {
    logger.error(`[FACTION TRACE ERROR] Failed to ensure log file: ${String(err)}`);
  }
}

/**
 * Append line to file (synchronous + safe)
 */
function appendToFile(line: string): void {
  try {
    ensureLogFile();
    fs.appendFileSync(OUTPUT_PATH, line + '\n', { encoding: 'utf-8' });
  } catch (err) {
    logger.error(`[FACTION TRACE ERROR] Failed to write log: ${String(err)}`);
  }
}

/**
 * Normalize faction value (defensive)
 */
function normalizeFaction(value: string): string {
  return value.trim();
}

/**
 * Main tracing function
 */
export function traceFaction(
  file: string,
  stage: string,
  factionValue: unknown
): void {
  if (typeof factionValue !== 'string') {
    return;
  }

  const normalized = normalizeFaction(factionValue);

  if (!TARGET_REGEX.test(normalized)) {
    return;
  }

  const timestamp = new Date().toISOString();

  const message =
    `[FACTION TRACE] ` +
    `time=${timestamp} ` +
    `file=${file} ` +
    `stage=${stage} ` +
    `value=${normalized}`;

  /**
   * Always log to both sinks
   */
  logger.info(message);
  appendToFile(message);
}