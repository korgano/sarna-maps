import fs from 'fs';
import yaml from 'yaml';
import { logger } from '../../common';

/**
 * Normalizes YAML content before parsing:
 * - Strips BOM
 * - Converts tabs to 2-space indentation
 * - Filters out blank lines to help the parser
 * - Detects and reports inconsistent indentation before parsing
 */
function normalizeYamlContent(content: string): string {
  let normalized = content;

  // Strip BOM if present
  if (normalized.charCodeAt(0) === 0xFEFF) {
    normalized = normalized.slice(1);
    logger.warn('read-and-parse-yaml-file.ts', 'BOM detected and stripped');
  }

  // Convert tabs to 2 spaces
  if (normalized.includes('\t')) {
    normalized = normalized.replace(/\t/g, '  ');
    logger.warn('read-and-parse-yaml-file.ts', 'Tab characters converted to spaces');
  }

  return normalized;
}

/**
 * Validates that the parsed YAML result is a non-null object (mapping).
 * YAML arrays and scalars are not valid config files.
 */
function validateParsedResult(result: unknown, filePath: string, contentDescription: string): result is Record<string, unknown> {
  if (result === null || result === undefined) {
    logger.error('read-and-parse-yaml-file.ts', `${contentDescription} file "${filePath}" is empty`);
    return false;
  }
  if (typeof result !== 'object' || Array.isArray(result)) {
    logger.error('read-and-parse-yaml-file.ts', `${contentDescription} file "${filePath}" must contain a mapping (object), got ${Array.isArray(result) ? 'array' : typeof result}`);
    return false;
  }
  return true;
}

/**
 * Attempts to read and parse a YAML file.
 * Normalizes indentation, strips BOM, converts tabs to spaces,
 * and validates the result is a mapping object.
 */
export function readAndParseYamlFile(filePath: string, contentDescription = 'YAML'): Record<string, unknown> | null {
  let fileContent: string;
  try {
    fileContent = fs.readFileSync(filePath, { encoding: 'utf8' });
  } catch (err) {
    logger.error('read-and-parse-yaml-file.ts', `Could not read ${contentDescription} file: ${filePath}`, err instanceof Error ? err.message : String(err));
    return null;
  }

  if (fileContent.trim() === '') {
    logger.error('read-and-parse-yaml-file.ts', `${contentDescription} file "${filePath}" is empty`);
    return null;
  }

  const normalized = normalizeYamlContent(fileContent);

  try {
    const result = yaml.parse(normalized);
    if (!validateParsedResult(result, filePath, contentDescription)) {
      return null;
    }
    return result as Record<string, unknown>;
  } catch (err) {
    if (err instanceof Error) {
      const yamlErr = err as Error & { pos?: number[] | number; linePos?: Array<{ line: number; col: number }> };
      const pos = ((yamlErr.pos as number[]) ?? [0])[0] ?? 0;
      const lineInfo = yamlErr.linePos?.map(lp => `line ${lp.line}, col ${lp.col}`).join(', ') ?? 'unknown';
      logger.error('read-and-parse-yaml-file.ts', `Could not parse ${contentDescription} at ${filePath}: ${yamlErr.message} (at ${lineInfo}). Check indentation - all mapping items must start at the same column.`);
    } else {
      logger.error('read-and-parse-yaml-file.ts', `Could not parse ${contentDescription} at ${filePath}: ${err}`);
    }
    return null;
  }
}
