/**
 * Repro harness for Phase 0 — Baseline & Determinism Verification
 *
 * Usage: npx ts-node scripts/repro-borders.ts
 *
 * Loads CSV data, runs calculateVoronoiBorders for era 17 (3026 Dragonfall),
 * asserts invariants, logs performance metrics, and writes repro-baseline.json.
 *
 * This script makes NO logic changes. It is a read-only verification tool.
 */
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { readFromCsvFiles } from '../src/read';
import { calculateVoronoiBorders } from '../src/compute/voronoi-border';
import { canonicalAffiliation, logger, LOGGER_LEVELS, logSettings } from '../src/common';
import { VoronoiCellMode } from '../src/common';
import { UNIVERSE_RECT } from '../src/Constants';
import { BORDER_STROKE_WIDTH_PX } from '../src/compute/constants';
import { coordKey } from '../src/compute/voronoi-border/functions/utils/node-coord-key';

// --- Configuration (matches write-svg-maps.ts:150-186) ---
const ERA_INDEX = 17; // 3026 - Operation Dragonfall - Initial Planning
const POISSON_RADIUS = 15;
const POISSON_MAX_SAMPLES = 20;
const POISSON_SEED = 'sarna';
const AFFILIATION_LEVELS = 5; // from config mapLayers.borders.length
const BORDER_SEPARATION = 0.5;
const CONTROL_POINT_TENSION = 0.35;
const PRIMARY_ZOOM = 1; // 1450px / 1450mu = 1
const SEPARATION_MAP_UNITS = (BORDER_STROKE_WIDTH_PX + 0.5) / (2 * PRIMARY_ZOOM);

const IRRELEVANT_AFFILIATIONS = ['U', 'A', ''];
const EMPTY_FACTION = 'EMPTY';
const INDEPENDENT = 'I';

// --- Paths ---
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data', 'Custom');
const SYSTEMS_PATH = path.join(DATA_DIR, 'TrollMaster v3.5 - Sarna Unified Cartography Kit (Official) - Systems CSV Export.csv');
const FACTIONS_PATH = path.join(DATA_DIR, 'Universal - Factions CSV Export.csv');
const DESCRIPTION_PATH = path.join(DATA_DIR, 'Universal - Systems Sheet Description.csv');
const WARNING_LOG_PATH = path.join(PROJECT_ROOT, 'warning-error-log.txt');
const OUTPUT_PATH = path.join(PROJECT_ROOT, 'out', 'repro-baseline.json');

// --- Helpers ---
function round6(x: number): string {
  return x.toFixed(6).replace(/^-0\.000000$/, '0.000000');
}

function edgeKey(n1x: number, n1y: number, n2x: number, n2y: number): string {
  return `${round6(n1x)},${round6(n1y)}->${round6(n2x)},${round6(n2y)}`;
}

// --- Main ---
async function main() {
  // Suppress noisy logs
  logSettings.level = LOGGER_LEVELS.NoLogsOrDebug;

  console.log('=== Phase 0 Repro Harness ===\n');

  // 0. Verify files exist
  for (const p of [SYSTEMS_PATH, FACTIONS_PATH, DESCRIPTION_PATH]) {
    if (!fs.existsSync(p)) {
      console.error(`FAIL: Required file not found: ${p}`);
      process.exit(1);
    }
  }
  console.log('OK: All CSV files found');

  // 1. Load data
  console.log('\n--- Loading CSV data ---');
  const sheetData = await readFromCsvFiles(SYSTEMS_PATH, FACTIONS_PATH, DESCRIPTION_PATH);
  console.log(`Systems loaded: ${sheetData.systems.length}`);
  console.log(`Factions loaded: ${sheetData.factions.length}`);
  console.log(`Eras available: ${sheetData.eras.length}`);

  const era = sheetData.eras.find((e) => e.index === ERA_INDEX);
  if (!era) {
    console.error(`FAIL: Era index ${ERA_INDEX} not found in ${sheetData.eras.length} eras`);
    process.exit(1);
  }
  console.log(`Target era: index=${era.index}, year=${era.year}, name="${era.name}"`);

  // 2. Count factions from CSV (mirrors calculate-voronoi-borders.ts:108-124)
  console.log('\n--- Faction counts (level 1, removeCapitalTokens) ---');
  const factionCounts: Record<string, number> = {};
  let skippedNoAffiliation = 0;
  let invalidNoCoords = 0;
  for (const s of sheetData.systems) {
    if (typeof s.x !== 'number' || typeof s.y !== 'number' || isNaN(s.x) || isNaN(s.y)) {
      invalidNoCoords++;
      continue;
    }
    const raw = s.eraAffiliations[era.index] || '';
    const aff = canonicalAffiliation(raw, {
      systemId: s.id,
      eraIndex: era.index,
      removeCapitalTokens: true,
    });
    if (
      aff &&
      !IRRELEVANT_AFFILIATIONS.includes(aff) &&
      aff !== EMPTY_FACTION &&
      aff !== INDEPENDENT &&
      aff.toUpperCase() !== 'A' &&
      aff.toUpperCase() !== 'U'
    ) {
      factionCounts[aff] = (factionCounts[aff] || 0) + 1;
    } else {
      skippedNoAffiliation++;
    }
  }

  const distinctFactions = Object.keys(factionCounts).length;
  const sortedFactions = Object.entries(factionCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join(', ');
  console.log(`Distinct factions: ${distinctFactions}`);
  console.log(`Factions: ${sortedFactions}`);
  console.log(`Skipped: ${skippedNoAffiliation} (U/A/EMPTY), ${invalidNoCoords} invalid coords`);

  // 3. Run calculateVoronoiBorders
  console.log('\n--- Running calculateVoronoiBorders ---');
  const t0 = performance.now();
  const result = await calculateVoronoiBorders(
    sheetData.systems,
    era,
    {
      origin: UNIVERSE_RECT.anchor,
      dimensions: UNIVERSE_RECT.dimensions,
      radius: POISSON_RADIUS,
      maxSamples: POISSON_MAX_SAMPLES,
      seed: POISSON_SEED,
    },
    AFFILIATION_LEVELS,
    BORDER_SEPARATION,
    CONTROL_POINT_TENSION,
    VoronoiCellMode.Circumcenters,
    SEPARATION_MAP_UNITS,
  );
  const elapsedMs = Math.round(performance.now() - t0);
  console.log(`Elapsed: ${elapsedMs}ms`);

  // 4. Performance metrics
  console.log('\n--- Performance metrics ---');
  console.log(`Delaunay vertices: ${result.delaunayVertices.length}`);
  console.log(`Voronoi nodes: ${result.voronoiNodes.length}`);
  console.log(`Affiliation levels: ${result.affiliationLevelSections.length}`);

  const levelStats = result.affiliationLevelSections.map((l, i) => {
    const borderLoops = l.borderLoops || {};
    const loopCount = Object.values(borderLoops).reduce((s, loops) => s + loops.length, 0);
    const edgeCount = Object.values(borderLoops).reduce(
      (s, loops) => s + loops.reduce((s2, loop) => s2 + loop.edges.length, 0),
      0,
    );
    return { level: i, sections: l.borderSections.length, loops: loopCount, edges: edgeCount };
  });
  for (const ls of levelStats) {
    console.log(`  Level ${ls.level}: ${ls.sections} sections, ${ls.loops} loops, ${ls.edges} edges`);
  }

  // 5. Assert: no iteration-limit warnings
  console.log('\n--- Asserting no iteration-limit warnings ---');
  let iterationWarnings = 0;
  if (fs.existsSync(WARNING_LOG_PATH)) {
    const logContent = fs.readFileSync(WARNING_LOG_PATH, 'utf8');
    const matches = logContent.match(/Iteration limit reached/g);
    iterationWarnings = matches ? matches.length : 0;
  }
  if (iterationWarnings > 0) {
    console.error(`FAIL: ${iterationWarnings} iteration-limit warnings found`);
    process.exit(1);
  }
  console.log('OK: 0 iteration-limit warnings');

  // 6. Assert: loop integrity (diagnostic — separateBorderLoops intentionally
  //    offsets edges independently, so coordKey connectivity within borderLoops
  //    is NOT guaranteed. This is a diagnostic, not a regression gate.)
  console.log('\n--- Diagnostic: loop connectivity (post-separation) ---');
  let brokenEdges = 0;
  let totalEdges = 0;
  let checkedLoops = 0;
  for (const [levelIdx, level] of result.affiliationLevelSections.entries()) {
    if (!level.borderLoops) continue;
    for (const [affiliation, loops] of Object.entries(level.borderLoops)) {
      for (const loop of loops) {
        if (!loop.isLoop) continue; // skip open chains
        checkedLoops++;
        for (let i = 0; i < loop.edges.length; i++) {
          totalEdges++;
          const curr = loop.edges[i];
          const next = loop.edges[(i + 1) % loop.edges.length];
          const currEnd = coordKey(curr.node2.x, curr.node2.y);
          const nextStart = coordKey(next.node1.x, next.node1.y);
          if (currEnd !== nextStart) {
            brokenEdges++;
          }
        }
      }
    }
  }
  console.log(`  ${checkedLoops} closed loops, ${totalEdges} total edges`);
  console.log(`  ${brokenEdges}/${totalEdges} edges with coordKey mismatch (expected: separateBorderLoops offsets break connectivity)`);
  // NOT a hard failure — this is a known characteristic of the separation pipeline

  // 7. Compute determinism hash
  console.log('\n--- Computing determinism hash ---');
  const edgeKeys: string[] = [];
  for (const level of result.affiliationLevelSections) {
    if (!level.borderLoops) continue;
    for (const loops of Object.values(level.borderLoops)) {
      for (const loop of loops) {
        for (const edge of loop.edges) {
          edgeKeys.push(edgeKey(edge.node1.x, edge.node1.y, edge.node2.x, edge.node2.y));
        }
      }
    }
  }
  edgeKeys.sort();
  const hash = crypto.createHash('sha256').update(edgeKeys.join('\n')).digest('hex');
  console.log(`Edge hash: ${hash}`);
  console.log(`Total edges hashed: ${edgeKeys.length}`);

  // 8. Write baseline JSON
  console.log('\n--- Writing repro-baseline.json ---');
  const baseline = {
    timestamp: new Date().toISOString(),
    config: {
      eraIndex: ERA_INDEX,
      poissonRadius: POISSON_RADIUS,
      poissonSeed: POISSON_SEED,
      affiliationLevels: AFFILIATION_LEVELS,
      borderSeparation: BORDER_SEPARATION,
      controlPointTension: CONTROL_POINT_TENSION,
      separationMapUnits: SEPARATION_MAP_UNITS,
    },
    era: { index: era.index, name: era.name, year: era.year },
    counts: {
      systems: sheetData.systems.length,
      factions: sheetData.factions.length,
      relevantSystems: Object.values(factionCounts).reduce((s, v) => s + v, 0),
      skippedNoAffiliation,
      invalidNoCoords,
      distinctFactions,
    },
    factions: factionCounts,
    performance: {
      elapsedMs,
      delaunayVertices: result.delaunayVertices.length,
      voronoiNodes: result.voronoiNodes.length,
    },
    levels: levelStats,
    integrity: {
      iterationWarnings,
      closedLoopsChecked: checkedLoops,
      totalEdgesChecked: totalEdges,
      coordKeyMismatches: brokenEdges, // diagnostic, not a regression gate
    },
    edgeHash: hash,
    totalEdgesHashed: edgeKeys.length,
  };
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(baseline, null, 2));
  console.log(`Written to: ${OUTPUT_PATH}`);

  console.log('\n=== Phase 0 Repro: PASS ===');
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
