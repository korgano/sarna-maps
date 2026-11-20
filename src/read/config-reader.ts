import { readAndParseYamlFile } from './common';
import {
  BorderLabelConfig,
  GeneratorConfig,
  DataSourceConfig,
  GlyphConfig,
  SystemLabelConfig,
  logger
} from '../common';
import {
  GeneratorConfigTi,
  GeneratorConfigMapLayerTi,
  GeneratorConfigOverlayTi,
} from '../common/types';
import { createCheckers } from 'ts-interface-checker';
import path from 'path';

export async function readConfigFiles(fileNames: {
  generatorConfig: string;
  dataSourceConfig: string;
  glyphConfig: string;
  systemLabelConfig: string;
  borderLabelConfig: string;
}) {
  const generatorConfig = readAndParseYamlFile(
    fileNames.generatorConfig,
    'Generator config',
  ) as Record<string, any>;

  if (!generatorConfig) {
    logger.error('config-reader.ts', `Failed to read generator config at ${fileNames.generatorConfig}. Check YAML indentation and file existence.`);
    process.exit(1);
  }

  const checkers = createCheckers(
    GeneratorConfigTi,
    GeneratorConfigMapLayerTi,
    GeneratorConfigOverlayTi,
  );
  try {
    checkers.GeneratorConfig.check(generatorConfig);
  } catch (e) {
    logger.error(
      'config-reader.ts',
      `The generator config at ${fileNames.generatorConfig} is not valid:\n` +
        e.message.replaceAll('value.', '').split('\n').map((line: string) => '  ' + line).join('\n'),
    );
    if (e.message.split('\n').length >= 3) {
      logger.error('config-reader.ts', '  ... (first three errors shown)');
    }
    logger.error('config-reader.ts', 'Please refer to the example configs and the generator config documentation.');
    process.exit(1);
  }
  logger.info(`Generator config at ${fileNames.generatorConfig} read and parsed successfully`);

  const dataSourceConfig = readAndParseYamlFile(
    fileNames.dataSourceConfig,
    'data source config'
  ) as unknown as DataSourceConfig;

  if (!dataSourceConfig) {
    logger.error('config-reader.ts', `Failed to read data source config at ${fileNames.dataSourceConfig}`);
    process.exit(1);
  }

  const globalDataSourceConfigPath = path.resolve(
    process.cwd(),
    'config/global/data-source.config.yaml'
  );

  const globalDataSourceConfig = readAndParseYamlFile(
    globalDataSourceConfigPath,
    'global data source config'
  ) as unknown as DataSourceConfig;

  if (!globalDataSourceConfig) {
    logger.error('config-reader.ts', `Failed to read global data source config at ${globalDataSourceConfigPath}`);
    process.exit(1);
  }

  function isValidLocalFileConfig(config: any): boolean {
  return (
    config !== undefined &&
    config !== null &&
    typeof config === 'object' &&
    Object.keys(config).length > 0
  );
  }

  const generatorHasLocal = isValidLocalFileConfig(generatorConfig?.localFileConfig);
  const globalHasLocal = isValidLocalFileConfig(globalDataSourceConfig.localFileConfig);

  if (generatorHasLocal) {
    dataSourceConfig.localFileConfig = generatorConfig.localFileConfig;
    logger.info(`Using localFileConfig from generatorConfig`);
  } else if (globalHasLocal) {
    dataSourceConfig.localFileConfig = globalDataSourceConfig.localFileConfig;
    logger.info('Using fallback localFileConfig from global data-source.config.yaml');
  } else {
    throw new Error(
      'localFileConfig not found in dataSourceConfig, generatorConfig, or global config'
    );
  }

  const glyphConfig = readAndParseYamlFile(
    fileNames.glyphConfig,
    'glyph config',
  ) as Partial<GlyphConfig>;
  if (!glyphConfig || !glyphConfig.regular || !glyphConfig.small) {
    throw new Error('Glyph configuration missing or incomplete');
  }
  glyphConfig.borderLabels = {
    ...glyphConfig.regular,
    ...glyphConfig.borderLabels,
  };

  const systemLabelConfig = readAndParseYamlFile(
    fileNames.systemLabelConfig,
    'system label config',
  ) as Partial<SystemLabelConfig>;
  if (!systemLabelConfig || !systemLabelConfig.padding || !systemLabelConfig.margins) {
    throw new Error('System label configuration missing or incomplete');
  }

  const borderLabelConfig = readAndParseYamlFile(
    fileNames.borderLabelConfig,
    'border label config',
  ) as Partial<BorderLabelConfig>;
  if (!borderLabelConfig) {
    throw new Error('Border label configuration missing or incomplete');
  }
  borderLabelConfig.rules = {
    ...{
      labelDistanceToBorder: 1,
      distanceBetweenCandidates: 1,
      borderIntersectionTolerance: 1,
      maxBorderIntersectionDistance: 1,
      minLoopDistanceBetweenLabels: 1,
      minDistanceBetweenLabels: 1,
      maxLabelOverlapArea: 1,
      cornerDistanceFactor: 1,
      minViableScore: 1,
      minGoodScore: 1,
      regionLabelBorderOverlapThreshold: 2,
    },
    ...(borderLabelConfig.rules || {}),
  };
  borderLabelConfig.scoreWeights = {
    ...{
      labelOverlap: 1,
      borderIntersection: 1,
      angle: 1,
      centeredness: 1,
      cornerScore: 1,
      multiline: 1,
      straightness: 1,
    },
    ...(borderLabelConfig.scoreWeights || {}),
  };
  borderLabelConfig.manualConfigs = borderLabelConfig.manualConfigs || {};

  return {
    generatorConfig: generatorConfig as GeneratorConfig,
    dataSourceConfig: dataSourceConfig as DataSourceConfig,
    glyphConfig: glyphConfig as GlyphConfig,
    systemLabelConfig: systemLabelConfig as SystemLabelConfig,
    borderLabelConfig: borderLabelConfig as BorderLabelConfig,
  };
}
