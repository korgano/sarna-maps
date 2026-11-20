import path from 'path';
import {
  BorderLabelConfig,
  Dimensions2d,
  Era, FactionRegistry,
  GeneratorConfigMapLayerFixedSize,
  GlyphConfig, logger,
  Point2d, RectangleGrid,
  System,
  SystemLabelConfig, TextTemplate
} from '../../../common';
import { FactionAffiliationPair, getCacheEntryBorderID } from '../../../read/common/retain-faction-affiliation-pairing';
import { normalizeFactionKey } from '../../../common/utils/normalize-faction-key';
import { restrictSystemsToViewbox } from '../../../compute/restrict-objects-to-viewbox';
import {
  BorderEdgeLoop,
  placeBorderLabels,
  // placeRegionLabels,
  placeSystemLabels,
  VoronoiResult,
  VoronoiResultHierarchyLevel
} from '../../../compute';
import {
  restrictBorderLoopsToViewbox
} from '../../../compute/restrict-objects-to-viewbox/functions/restrict-border-loops-to-viewbox';
import { renderBorderLoops } from './render-border-loops';
import { renderNeutralBoundaries } from './render-neutral-boundaries';
import { renderSystems } from './render-systems';
import { renderSystemLabels } from './render-system-labels';
import { renderBorderLabels } from './render-border-labels';
import { renderJumpRings } from './render-jump-rings';
import { renderDirectionalIndicators } from './render-directional-indicators';
import { generateConnectionLines } from '../../../compute/connection-lines';
import { renderConnectionLines } from './render-connection-lines';
import { renderSalients } from './render-salients';
import { renderRegionalBorders } from './render-regional-borders';
import { extractBorderStateAffiliation, getAbandonedBorderFaction, isAbandonedAffiliation } from '../../../common';
import { EMPTY_FACTION, INDEPENDENT } from '../../../compute/constants';

/**
 * Render a single configured map section
 *
 * @param theme The render color theme
 * @param imageDimensions The parent map image dimensions
 * @param mapLayerConfig The configuration object for this map layer
 * @param globalConfigs The global configuration objects
 * @param era The selected era for this image
 * @param factionMap The map of factions (factionId -> faction object)
 * @param pairs The faction affiliation pairs map for render pipeline
 * @param affiliationLevelSections The border information in an array (by hierarchy level)
 * @param systems The list of all systems
 * @param focusedSystem The focused system for this map section, if any
 * @param debugObjects Objects used for virtual debugging
 */
export function renderMapLayer(
  theme: 'light' | 'dark',
  imageDimensions: Dimensions2d,
  mapLayerConfig: GeneratorConfigMapLayerFixedSize,
  globalConfigs: {
    glyphConfig: GlyphConfig;
    systemLabelConfig: SystemLabelConfig;
    borderLabelConfig: BorderLabelConfig;
  },
  era: Era,
  factionRegistry: FactionRegistry,
  pairs: Map<string, FactionAffiliationPair>,
  affiliationLevelSections: Array<VoronoiResultHierarchyLevel>,
  systems: Array<System>,
  focusedSystem?: System,
  debugObjects?: Partial<VoronoiResult>,
) {
  // PHASE 1: PREPARE ALL NECESSARY DATA
  const pixelDimensions = mapLayerConfig.dimensions || imageDimensions;
  // TODO what about height?
  const zoomFactor = pixelDimensions.width / mapLayerConfig.mapUnitDimensions.width;

  // determine map section focus (= central) point, in map coordinates
  const focusPoint: Point2d =
    mapLayerConfig.focus?.point === 'system' && focusedSystem
      ? { x: focusedSystem.x, y: focusedSystem.y }
      : (mapLayerConfig.focus?.point as Point2d) || { x: 0, y: 0 };

  // calculate the visible map section
  const visibleViewRect = {
    anchor: {
      x: focusPoint.x - (mapLayerConfig.focus?.delta?.x || 0) - mapLayerConfig.mapUnitDimensions.width * 0.5,
      y: focusPoint.y - (mapLayerConfig.focus?.delta?.y || 0) - mapLayerConfig.mapUnitDimensions.height * 0.5,
    },
    dimensions: mapLayerConfig.mapUnitDimensions,
  };

  let transform = `scale(${zoomFactor.toFixed(6)}) ` +
    `translate(${(-focusPoint.x + (mapLayerConfig.focus?.delta?.x || 0) + mapLayerConfig.mapUnitDimensions.width * 0.5).toFixed(3)},` +
    `${(focusPoint.y - (mapLayerConfig.focus?.delta?.y || 0) + mapLayerConfig.mapUnitDimensions.height * 0.5).toFixed(3)})`;
  if (mapLayerConfig.position) {
    transform = `translate(${mapLayerConfig.position.x},${mapLayerConfig.position.y}) ${transform}`;
  }

  const visibleSystems = mapLayerConfig.elements.systems || mapLayerConfig.elements.systemLabels
    ? restrictSystemsToViewbox(visibleViewRect, systems)
    : [];

  // Create a rectangle grid that will let us check for label collisions
  const labelGrid = new RectangleGrid(visibleViewRect);

  // Place system labels
  const systemLabels = mapLayerConfig.elements.systemLabels
    ? placeSystemLabels(
        visibleViewRect,
        era.index,
        visibleSystems,
        labelGrid,
        globalConfigs.glyphConfig,
        globalConfigs.systemLabelConfig,
      )
    : [];

  const connectionLines = !!mapLayerConfig.elements.connectionLines
    ? generateConnectionLines(
      systems,
      visibleViewRect,
      mapLayerConfig.elements.connectionLines.minimumDistance,
      mapLayerConfig.elements.connectionLines.maximumDistance
    ) : [];

  // Limit internal border sections to the visible section of the map
  // TODO implement simple bounding algorithm
  const boundedInternalBorders = !!mapLayerConfig.elements.borders
    ? affiliationLevelSections.map((levelSection) =>
      levelSection.internalBorderSections || []
    )
    : [];

  // Limit border loops to the visible section of the map.
  //
  // UNIFIED CONSTRAINT: `fillLoops` (pre-separation gapless geometry) is the
  // canonical source for BOTH Pass 1 clip paths (renderNeutralBoundaries) and
  // Pass 2 fills/strokes (renderBorderLoops). Using the same restricted result
  // for both prevents clip path ↔ geometry divergence that could cause
  // hairline gaps or bleed at viewbox edges.
  //
  // `borderLoops` (separated/pulled geometry) is only used to determine which
  // factions have borders; it is never used for fill or stroke rendering.
  const boundedFillLoops = !!mapLayerConfig.elements.borders
    ? affiliationLevelSections.map((levelSection) =>
      restrictBorderLoopsToViewbox(levelSection.fillLoops || levelSection.borderLoops || {}, visibleViewRect, 15)
    )
    : [];

  const boundedBorderLoops = !!mapLayerConfig.elements.borders
    ? affiliationLevelSections.map((levelSection) =>
      restrictBorderLoopsToViewbox(levelSection.borderLoops || {}, visibleViewRect, 15)
    )
    : [];

  // Place border labels for faction level (level 0)
  const borderLabels = (mapLayerConfig.elements.borders?.length || 0) >= 1
    ? placeBorderLabels(
        visibleViewRect,
        era.index,
        factionRegistry,
        affiliationLevelSections.length ? affiliationLevelSections[0].borderLoops || {} : {},
        labelGrid,
        globalConfigs.glyphConfig,
        globalConfigs.borderLabelConfig,
      )
    : { candidatesByFaction: {} };

  // Region border labels (hierarchy levels 1+) are not rendered yet; see the
  // renderMapLayer TODO notes for the intended design.

  // PHASE 2: RENDER ELEMENTS
  const layerCssClass = mapLayerConfig.name.replace(/\s+/g, '-');

  // TODO enable for lower hierarchy levels, specifically figure out how to manage fill colors
  let neutralDefs = '';
  let neutralCss = '';
  let neutralMarkup = '';
  let factionDefs = '';
  let factionCss = '';
  let factionMarkup = '';

  // Compute systemsByFaction once — shared by renderNeutralBoundaries and renderBorderLoops.
  //
  // Uses the cached borderID from parse-systems-v3-csv (stage 2 enrichment) as the
  // canonical faction key, so render and Voronoi compute agree on which faction
  // each system belongs to. borderID is the A(<FACTION>)-unwrapped, level-1
  // affiliation — exactly what calculateVoronoiBorders seeds the Voronoi with.
  // Keys fold with trim().toUpperCase() to match groupBorderLoopsByUpperKey exactly;
  // a mismatch here makes whole-faction loop lookups miss (e.g. AuC vs AUC).
  //
  // Falls back to extracting from the raw era cell if the enrichment cache is empty
  // (e.g. when parseSystemsV3Csv was not run), preserving backward compatibility.
  const systemsByFaction: Record<string, Array<System>> = {};
  systems.forEach((system) => {
    const cacheKey = `${system.id}_${era.index}`;
    // borderID from parse-systems-v3-csv: A(<FACTION>) -> <FACTION>, bare A -> 'A',
    // disputed D(LC,DC) -> 'D(LC,DC)' (raw form preserved; caller normalizes).
    const borderID = getCacheEntryBorderID(cacheKey);
    let affiliation: string;
    if (borderID) {
      // Use the cached borderID directly — it already reflects parse-systems-v3-csv
      // parsing (A-unwrap, first-token extraction). Only the top-level faction key
      // is needed for systemsByFaction grouping, so take level 1.
      affiliation = extractBorderStateAffiliation(borderID, ['', 'A', 'U'], 'ignore', 1);
    } else {
      // Fallback: normalize from the raw era cell (should not happen when the
      // enrichment stage ran, but keeps behavior safe if it didn't).
      const rawAffiliation = system.eraAffiliations[era.index] || '';
      const normalizedAffiliation = normalizeFactionKey(rawAffiliation);
      affiliation = isAbandonedAffiliation(normalizedAffiliation)
        ? getAbandonedBorderFaction(normalizedAffiliation)
        : extractBorderStateAffiliation(normalizedAffiliation, ['', 'A', 'U'], 'ignore', 1);
    }
    if (!affiliation || affiliation === EMPTY_FACTION || affiliation === INDEPENDENT) {
      return;
    }
    // Trim + upper-case to match groupBorderLoopsByUpperKey exactly.
    const key = affiliation.trim().toUpperCase();
    if (!systemsByFaction[key]) {
      systemsByFaction[key] = [];
    }
    systemsByFaction[key].push(system);
  });

  mapLayerConfig.elements.borders?.forEach((bordersConfig, levelIndex) => {
    if (bordersConfig.display === 'factions') {
      if (boundedBorderLoops.length < levelIndex + 1) {
        logger.warn('render-map-layer.ts', `Cannot generate output for map layer "${mapLayerConfig.name}": No bounded border loops for level ${levelIndex}`);
        return;
      }
      // Pass 1: Neutral boundary layer (gapless fill geometry for clips).
      const neutralResult = renderNeutralBoundaries(
        boundedFillLoops[levelIndex] || boundedBorderLoops[levelIndex],
        theme,
        layerCssClass,
        systemsByFaction,
      );
      const clipPathIds = neutralResult.clipPathIds;
      neutralDefs += neutralResult.defs + '\n';
      neutralCss += neutralResult.css + '\n';
      neutralMarkup += neutralResult.markup + '\n';
      // Pass 2: Faction borders and fills (colored, clipped to neutral boundaries).
      // Fills use the PRE-PULL (gapless) fillLoops so adjacent faction territories
      // touch without gaps. Strokes use the SAME fillLoops geometry so they align
      // perfectly with region borders — every external border has a corresponding
      // stroke that runs flush with adjacent borders. Strokes are trimmed against
      // foreign fills (fills win) only where they genuinely overlap foreign territory.
      const { defs, css, markup } = renderBorderLoops(
        boundedBorderLoops[levelIndex],
        boundedFillLoops[levelIndex],
        factionRegistry,
        pairs,
        theme,
        bordersConfig.curveBorderEdges,
        layerCssClass,
        systemsByFaction,
        clipPathIds,
      );
      factionDefs += defs + '\n';
      factionCss += css + '\n';
      factionMarkup += markup + '\n';
    } else if (bordersConfig.display === 'regions') {
      const { css, markup } = renderRegionalBorders(
        // affiliationLevelSections[levelIndex].borderSections,
        levelIndex,
        boundedInternalBorders[levelIndex],
        factionRegistry,
        theme,
        bordersConfig.curveBorderEdges,
      );
      factionCss += css + '\n';
      factionMarkup += markup + '\n';
    }
  });
  // Render faction border labels (level 0)
  const { defs: borderLabelDefs, css: borderLabelCss, markup: borderLabelMarkup } =
    mapLayerConfig.elements.borders?.length && mapLayerConfig.elements.borders[0].borderLabels
      ? renderBorderLabels(borderLabels, factionRegistry, theme, layerCssClass, zoomFactor)
      : { defs: '', css: '', markup: '' };

  // Region border labels (levels 1+) are not rendered yet; see the commented
  // placeRegionLabels call site in this file for the intended design.

  const { defs: jumpRingDefs, css: jumpRingCss, markup: jumpRingMarkup } = mapLayerConfig.elements.jumpRings
    ? renderJumpRings(mapLayerConfig, focusPoint, theme, layerCssClass)
    : { defs: '', css: '', markup: '' };

  const { defs: connectionLineDefs, css: connectionLineCss, markup: connectionLineMarkup } =
    mapLayerConfig.elements.connectionLines
      ? renderConnectionLines(connectionLines, theme)
      : { defs: '', css: '', markup: '' };

  const { defs: systemDefs, css: systemCss, markup: systemMarkup } = mapLayerConfig.elements.systems
    ? renderSystems(visibleSystems, factionRegistry, theme, era.index, layerCssClass)
    : { defs: '', css: '', markup: '' };

  const { css: systemLabelCss, markup: systemLabelMarkup } = mapLayerConfig.elements.systemLabels
    ? renderSystemLabels(systemLabels, theme, layerCssClass, zoomFactor)
    : { css: '', markup: '' };

  const { css: directionalIndicatorsCss, markup: directionalIndicatorsMarkup } =
    renderDirectionalIndicators(
      globalConfigs.glyphConfig,
      visibleViewRect,
      mapLayerConfig.elements.directionalIndicators || [],
      theme,
      layerCssClass,
    );

  let debugDefs = '';
  let debugCss = '';
  let debugMarkup = '';
  if (debugObjects) {
    const { css: salientsCss, markup: salientsMarkup } =
      renderSalients(
        debugObjects.salientPoints || [],
        theme,
      );
    const regionalBorderSectionsCss = '';
    const regionalBorderSectionsMarkup = '';
    debugCss = [salientsCss, regionalBorderSectionsCss].join('\n');
    debugMarkup = [salientsMarkup, regionalBorderSectionsMarkup].join('\n');
  }

  // PHASE 3: Assemble and return result
  const templatePath = path.join(__dirname, '../templates/', theme);
  const layerTemplate = new TextTemplate('map-section.svg.tpl', templatePath);
  const defsTemplate = new TextTemplate('map-section-def.svg.tpl', templatePath);
  const cssTemplate = new TextTemplate('map-section.css.tpl', templatePath);
  const mapSectionCss = cssTemplate.replace({
    css_class: layerCssClass,
  });
  const mapSectionDef = defsTemplate.replace({
    id: layerCssClass + '-clip-path',
    x: visibleViewRect.anchor.x.toFixed(3),
    y: (-focusPoint.y + (mapLayerConfig.focus?.delta?.y || 0) - mapLayerConfig.mapUnitDimensions.height * 0.5).toFixed(3),
    width: visibleViewRect.dimensions.width,
    height: visibleViewRect.dimensions.height,
  });

  const markup = [
    neutralMarkup,
    factionMarkup,
    borderLabelMarkup,
    // regionBorderLabelMarkup,
    jumpRingMarkup,
    connectionLineMarkup,
    systemMarkup,
    systemLabelMarkup,
    directionalIndicatorsMarkup,
    debugMarkup,
  ]
    .filter((code) => !!code.trim())
    .join('\n');
  if (markup) {
    const allDefs = [mapSectionDef, neutralDefs, factionDefs, borderLabelDefs, /*regionBorderLabelDefs,*/ jumpRingDefs, systemDefs, debugDefs]
      .filter((code) => !!code.trim())
      .join('\n');
    const allCss = [
      mapSectionCss,
      neutralCss,
      factionCss,
      borderLabelCss,
      /*regionBorderLabelCss,*/
      jumpRingCss,
      systemCss,
      connectionLineCss,
      systemLabelCss,
      directionalIndicatorsCss,
      debugCss,
    ]
      .filter((code) => !!code.trim())
      .join('\n');

    // Validate that every clip-path / url(#...) reference has a matching <defs> element.
    // Catches missing clip paths that would let fills/strokes bleed into neighboring factions.
    assertFillDefsPresent(allDefs, allCss, 'render-map-layer.ts');

    // Validate CSS doesn't contain characters that break strict renderers (e.g. Inkscape).
    // Catches newlines within property values that cause factions to render black.
    assertCssClean(allCss, 'render-map-layer.ts');

    return {
      defs: allDefs,
      css: allCss,
      markup: layerTemplate.replace({
        name: mapLayerConfig.name,
        css_class: layerCssClass,
        // TODO make this into its own rect
        x: visibleViewRect.anchor.x.toFixed(3),
        y: (-focusPoint.y + (mapLayerConfig.focus?.delta?.y || 0) - mapLayerConfig.mapUnitDimensions.height * 0.5).toFixed(3),
        width: visibleViewRect.dimensions.width,
        height: visibleViewRect.dimensions.height,
        transform,
        content: markup,
        clip_path_id: layerCssClass + '-clip-path',
      }),
    };
  } else {
    return {
      defs: '',
      css: '',
      markup: '',
    };
  }
}

/**
 * Guard: verify that every url(#id) referenced in the CSS has a matching
 * element in the defs block. Logs an error for each missing def.
 */
export function assertFillDefsPresent(defs: string, css: string, sourceFile: string): void {
  const urlRefs = css.matchAll(/url\(#([^)]+)\)/g);
  const definedIds = new Set<string>();
  const idMatches = defs.matchAll(/id="([^"]+)"/g);
  for (const m of idMatches) {
    definedIds.add(m[1]);
  }

  for (const m of urlRefs) {
    const refId = m[1];
    if (!definedIds.has(refId)) {
      logger.error(
        sourceFile,
        `Missing fill def: CSS references url(#${refId}) but no matching element found in <defs>.`
      );
    }
  }
}

/**
 * Guard: verify that generated CSS contains no characters that could break
 * strict CSS parsers (e.g. Inkscape). Newlines within property values,
 * carriage returns, and other control characters can cause renderers to
 * reject the entire CSS rule, resulting in factions appearing with default
 * colors (black).
 *
 * @param css The generated CSS string to validate
 * @param sourceFile The source file calling this guard, for error logging
 */
export function assertCssClean(css: string, sourceFile: string): void {
  const lines = css.split('\n');
  let hasIssues = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Check for carriage returns
    if (line.includes('\r')) {
      logger.error(sourceFile, `CSS line ${i + 1} contains carriage return character`);
      hasIssues = true;
    }
    // Check for lines that start with whitespace followed by a property
    // (indicates a property value was split across lines)
    if (/^\s+(stroke|fill|stroke-width|fill-opacity|stroke-opacity):/.test(line)) {
      logger.error(
        sourceFile,
        `CSS line ${i + 1} appears to be a continuation of a property value from the previous line (possible newline within CSS rule)`
      );
      hasIssues = true;
    }
  }
  if (hasIssues) {
    logger.error(
      sourceFile,
      'CSS contains characters that may break strict renderers (e.g. Inkscape). Factions may render with default colors.'
    );
  }
}
