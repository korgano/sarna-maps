import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import { logger } from '../src/common';

const CONFIG_DIR = path.resolve(process.cwd(), 'config');
const GLOBAL_CONFIG_DIR = path.resolve(process.cwd(), 'config', 'global');

function findYamlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map(f => path.join(dir, f));
}

function validateYaml(filePath: string): boolean {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    if (content.trim() === '') {
      logger.warn('config-lint', `Empty file: ${filePath}`);
      return false;
    }
    const result = yaml.parse(content);
    if (result === null || result === undefined) {
      logger.error('config-lint', `Empty/null result: ${filePath}`);
      return false;
    }
    if (typeof result !== 'object' || Array.isArray(result)) {
      logger.error('config-lint', `Not a mapping object: ${filePath}`);
      return false;
    }
    const obj = result as Record<string, unknown>;
    if (Object.keys(obj).length === 0) {
      logger.warn('config-lint', `Empty mapping: ${filePath}`);
      return false;
    }
    return true;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error('config-lint', `Invalid YAML at ${filePath}: ${errMsg}`);
    return false;
  }
}

function main() {
  logger.info('config-lint', 'Validating YAML config files...');
  const allDirs = [CONFIG_DIR, GLOBAL_CONFIG_DIR];
  let hasErrors = false;
  let fileCount = 0;

  for (const dir of allDirs) {
    const files = findYamlFiles(dir);
    for (const file of files) {
      fileCount++;
      if (!validateYaml(file)) {
        hasErrors = true;
      }
    }
  }

  if (hasErrors) {
    logger.error('config-lint', `${fileCount} config files scanned. Validation FAILED.`);
    process.exit(1);
  }
  logger.info('config-lint', `${fileCount} config files validated successfully.`);
}

main();
