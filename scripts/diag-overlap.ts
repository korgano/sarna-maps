/**
 * Diagnostic for "Faction territory overlap detected" errors emitted by
 * render-border-loops.ts (config: innersphere-Dragonfall-v3-CSV, era 17).
 *
 * Read-only analysis tool — makes NO logic changes.
 *
 * It recomputes the level-0 Voronoi border result exactly the way
 * write-svg-maps.ts does, then classifies every detected fill overlap by:
 *   1. depth        — how far the offending vertex sits inside the foreign fill
 *   2. span         — bounding box of the mutually covered vertices
 *   3. hole status  — whether the foreign loop is a pocket hole of the parent,
 *                     and if so whether buildFillEntries dropped it
 *   4. curves       — whether the overlap survives with renderCurves=false
 *   5. viewbox      — whether the overlap exists before restrictBorderLoopsToViewbox
 *   6. control pts  — whether the two factions' copies of a shared edge carry
 *                     different bezier control points
 *
 * Usage: npx ts-node scripts/diag-overlap.ts
 */
import path from 'path';

import { LOGGER_LEVELS, logSettings, Point2d } from '../src/common';
import { readConfigFiles, readFromCsvFiles } from '../src/read';
import { calculateVoronoiBorders } from '../src/compute/voronoi-border';
import { BorderEdgeLoop } from '../src/compute';
import { EMPTY_FACTION, INDEPENDENT } from '../src/compute/constants';
import { restrictBorderLoopsToViewbox } from '../src/compute/restrict-objects-to-viewbox/functions/restrict-border-loops-to-viewbox';
import {
  buildFillEntries,
  buildFillRegions,
  detectOverlappingRegions,
  FillEntry,
  FillRegion,
  loopToPoints,
  regionCovers,
} from '../src/render/svg/functions/fill-constraints';
import {
  findPocketHoles,
  groupBorderLoopsByUpperKey,
} from '../src/render/svg/functions/normalize-border-loops';
import { isDisputedAffiliation } from '../src/common/utils/disputed-affiliation';
import { polygonContains } from '../src/common/math-2d/polygon-contains';
import { UNIVERSE_RECT } from '../src/Constants';

const CONFIG_NAME = 'innersphere-Dragonfall-v3-CSV';
const ERA_INDEX = 17;

// --- local copies of private helpers from fill-constraints.ts ---

function distancePointToSegment(p: Point2d, a: Point2d, b: Point2d): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) {
    t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
  }
  const cx = a.x + t * dx - p.x;
  const cy = a.y + t * dy - p.y;
  return Math.sqrt(cx * cx + cy * cy);
}

function distanceToContours(contours: Array<Array<Point2d>>, p: Point2d): number {
  let min = Infinity;
  for (const contour of contours) {
    for (let i = 0, j = contour.length - 1; i < contour.length; j = i++) {
      const d = distancePointToSegment(p, contour[j], contour[i]);
      if (d < min) min = d;
    }
  }
  return min;
}

// --- region building (mirrors render-border-loops.ts pre-pass) ---

function buildRegions(
  loopsByFaction: Record<string, Array<BorderEdgeLoop>>,
  renderCurves: boolean,
): { regions: Array<FillRegion>; entriesByKey: Record<string, Array<FillEntry>> } {
  const entriesByKey: Record<string, Array<FillEntry>> = {};
  for (const factionKey of Object.keys(loopsByFaction)) {
    if (!factionKey || factionKey === EMPTY_FACTION || factionKey === INDEPENDENT) continue;
    entriesByKey[factionKey] = buildFillEntries(
      factionKey,
      isDisputedAffiliation(factionKey),
      loopsByFaction[factionKey] || [],
      loopsByFaction,
      renderCurves,
    );
  }
  return { regions: buildFillRegions(entriesByKey), entriesByKey };
}

interface PairMetrics {
  a: string;
  b: string;
  bInsideA: number;
  bTotal: number;
  maxDepth: number;
  spanW: number;
  spanH: number;
  holeStatus: string;
}

function distanceToRegion(region: FillRegion, p: Point2d): number {
  let min = Infinity;
  for (const entry of region.entries) {
    const d = distanceToContours(entry.contours, p);
    if (d < min) min = d;
  }
  return min;
}

function countVertices(region: FillRegion): number {
  let n = 0;
  for (const entry of region.entries) {
    for (const contour of entry.contours) n += contour.length;
  }
  return n;
}

function classifyPair(
  a: FillRegion,
  b: FillRegion,
  entriesByKey: Record<string, Array<FillEntry>>,
  allLoops: Record<string, Array<BorderEdgeLoop>>,
): PairMetrics {
  const covered: Array<Point2d> = [];
  let total = 0;
  let maxDepth = 0;
  for (const entry of b.entries) {
    for (const contour of entry.contours) {
      for (const p of contour) {
        total++;
        if (regionCovers(a, p, 0.01)) {
          covered.push(p);
          const depth = distanceToRegion(a, p);
          if (depth > maxDepth) maxDepth = depth;
        }
      }
    }
  }

  let spanW = 0;
  let spanH = 0;
  if (covered.length > 0) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of covered) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    spanW = maxX - minX;
    spanH = maxY - minY;
  }

  // Hole status: is any of B's loops a pocket hole of A, and was it admitted?
  const candidatesA = (allLoops[a.factionKey] || []).filter(
    (loop) =>
      ![undefined, EMPTY_FACTION].includes(loop.innerAffiliation) &&
      (isDisputedAffiliation(a.factionKey) ||
        (loop.innerAffiliation || '').toUpperCase() === a.factionKey.toUpperCase()),
  );
  const pocketHolesA = findPocketHoles(candidatesA, allLoops, a.factionKey);
  const admitted = new Set<BorderEdgeLoop>();
  for (const entry of entriesByKey[a.factionKey] || []) {
    for (const h of entry.holes) admitted.add(h);
  }
  const bLoops = allLoops[b.factionKey] || [];
  let holeStatus = 'not-a-hole';
  for (const loop of bLoops) {
    if (pocketHolesA.indexOf(loop) >= 0) {
      holeStatus = admitted.has(loop) ? 'hole-admitted' : 'HOLE-DROPPED';
      break;
    }
  }

  return {
    a: a.factionKey,
    b: b.factionKey,
    bInsideA: covered.length,
    bTotal: total,
    maxDepth,
    spanW,
    spanH,
    holeStatus,
  };
}

function analyze(
  label: string,
  loopsByFaction: Record<string, Array<BorderEdgeLoop>>,
  renderCurves: boolean,
  detail: boolean,
): number {
  const { regions, entriesByKey } = buildRegions(loopsByFaction, renderCurves);
  const overlaps = detectOverlappingRegions(regions);
  console.log(`\n=== ${label} ===`);
  console.log(`factions with fill entries: ${regions.length}, overlaps: ${overlaps.length}`);

  const byKey = new Map<string, FillRegion>();
  for (const r of regions) byKey.set(r.factionKey, r);

  if (detail && overlaps.length > 0) {
    const rows: Array<PairMetrics> = [];
    for (const ov of overlaps) {
      const ra = byKey.get(ov.factionA);
      const rb = byKey.get(ov.factionB);
      if (!ra || !rb) continue;
      rows.push(classifyPair(ra, rb, entriesByKey, loopsByFaction));
    }
    rows.sort((x, y) => y.maxDepth - x.maxDepth);
    console.log(
      'pair'.padEnd(22) +
        'depth'.padStart(8) +
        'spanW'.padStart(9) +
        'spanH'.padStart(9) +
        'bInA/bTot'.padStart(12) +
        '  holeStatus',
    );
    for (const r of rows) {
      const cls =
        r.holeStatus === 'HOLE-DROPPED'
          ? ' <== hole dropped by vertex filter'
          : r.bInsideA === r.bTotal && r.bTotal > 0
            ? ' <== fully inside, no hole'
            : r.maxDepth < 2
              ? ' <== sliver'
              : ' <== crossing';
      console.log(
        `${(r.a + ' <-> ' + r.b).padEnd(22)}${r.maxDepth.toFixed(3).padStart(8)}` +
          `${r.spanW.toFixed(2).padStart(9)}${r.spanH.toFixed(2).padStart(9)}` +
          `${`${r.bInsideA}/${r.bTotal}`.padStart(12)}  ${r.holeStatus}${cls}`,
      );
    }
  }
  return overlaps.length;
}

function checkControlPoints(grouped: Record<string, Array<BorderEdgeLoop>>): void {
  interface Rec {
    key: string;
    c1: Point2d | null | undefined;
    c2: Point2d | null | undefined;
    n1: Point2d;
    n2: Point2d;
  }
  const byId = new Map<string, Array<Rec>>();
  for (const [key, loops] of Object.entries(grouped)) {
    for (const loop of loops) {
      for (const e of loop.edges) {
        const rec: Rec = {
          key,
          c1: e.n1c2,
          c2: e.n2c1,
          n1: { x: e.node1.x, y: e.node1.y },
          n2: { x: e.node2.x, y: e.node2.y },
        };
        const list = byId.get(e.id) || [];
        list.push(rec);
        byId.set(e.id, list);
      }
    }
  }

  // Orientation-aware comparison: the same geometric edge is stored reversed
  // in the opposing faction's loop, so handle-at-node must be matched
  // node-wise (A's handle @ A.n1 vs B's handle @ B.n2 when B is reversed),
  // never c1-to-c1. Also detects presence mismatch (cubic on one side,
  // quadratic on the other).
  const pDelta = (a: Point2d | null | undefined, b: Point2d | null | undefined): number => {
    if (!!a !== !!b) return Infinity;
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  let sharedIds = 0;
  let ctrlDiffer = 0;
  let nodeDiffer = 0;
  let presenceMismatch = 0;
  let maxNodeDelta = 0;
  let maxCtrlDelta = 0;
  let maxCurveDev = 0;
  let curveDiffer = 0;
  const examples: Array<string> = [];
  const curveExamples: Array<string> = [];
  for (const [id, recs] of byId) {
    const keys = new Set(recs.map((r) => r.key));
    if (keys.size < 2) continue;
    sharedIds++;
    const first = recs[0];
    for (let i = 1; i < recs.length; i++) {
      const other = recs[i];
      // Try same orientation and reversed orientation, keep the better fit.
      const sameOrient = Math.max(
        Math.hypot(first.n1.x - other.n1.x, first.n1.y - other.n1.y),
        Math.hypot(first.n2.x - other.n2.x, first.n2.y - other.n2.y),
      );
      const revOrient = Math.max(
        Math.hypot(first.n1.x - other.n2.x, first.n1.y - other.n2.y),
        Math.hypot(first.n2.x - other.n1.x, first.n2.y - other.n1.y),
      );
      const reversed = revOrient < sameOrient;
      const nodeDelta = Math.min(sameOrient, revOrient);
      if (nodeDelta > 1e-9) {
        nodeDiffer++;
        if (nodeDelta > maxNodeDelta) maxNodeDelta = nodeDelta;
      }
      // Handle at first.n1: other's c2 if reversed (other.n2 == first.n1).
      const h1 = pDelta(first.c1, reversed ? other.c2 : other.c1);
      const h2 = pDelta(first.c2, reversed ? other.c1 : other.c2);
      const ctrlDelta = Math.max(h1, h2);
      if (!isFinite(ctrlDelta)) presenceMismatch++;
      if (ctrlDelta > 1e-9) {
        ctrlDiffer++;
        if (isFinite(ctrlDelta)) {
          if (ctrlDelta > maxCtrlDelta) maxCtrlDelta = ctrlDelta;
          if (examples.length < 10) {
            examples.push(
              `  ${id} [${[...keys].join(', ')}]${reversed ? ' (rev)' : ''} handle delta ${ctrlDelta.toFixed(4)}`,
            );
          }
        }
      }

      // Direct curve divergence: sample both clones' cubic for this edge and
      // measure max pointwise distance (other sampled mirrored if reversed).
      const sample = (r: Rec, t: number): Point2d => {
        const p0 = r.n1;
        const p3 = r.n2;
        const c1 = r.c1 || { x: (p0.x + p3.x) / 2, y: (p0.y + p3.y) / 2 };
        const c2 = r.c2 || { x: (p0.x + p3.x) / 2, y: (p0.y + p3.y) / 2 };
        const mt = 1 - t;
        return {
          x: mt * mt * mt * p0.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * p3.x,
          y: mt * mt * mt * p0.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * p3.y,
        };
      };
      const N = 16;
      let dev = 0;
      for (let s = 1; s < N; s++) {
        const t = s / N;
        const pa = sample(first, t);
        const pb = sample(other, reversed ? 1 - t : t);
        dev = Math.max(dev, Math.hypot(pa.x - pb.x, pa.y - pb.y));
      }
      if (dev > 1e-6) {
        curveDiffer++;
        if (dev > maxCurveDev) maxCurveDev = dev;
        if (curveExamples.length < 12) {
          curveExamples.push(
            `  ${id} [${[...keys].join(', ')}]${reversed ? ' (rev)' : ''} curve divergence ${dev.toFixed(4)} @t=${(Math.round(dev > 0 ? 0 : 0))}`,
          );
        }
      }
    }
  }
  console.log('\n=== Shared-edge control point check (orientation-aware, raw fillLoops) ===');
  console.log(`edge ids shared by >=2 faction keys: ${sharedIds}`);
  console.log(`  clone pairs with differing node coords  : ${nodeDiffer} (max ${maxNodeDelta.toFixed(4)})`);
  console.log(`  clone pairs with differing handles      : ${ctrlDiffer} (max ${maxCtrlDelta.toFixed(4)})`);
  console.log(`  clone pairs with cubic/quad mismatch    : ${presenceMismatch}`);
  console.log(`  clone pairs with divergent curves       : ${curveDiffer} (max divergence ${maxCurveDev.toFixed(4)})`);
  for (const ex of examples) console.log(ex);
  if (curveExamples.length) {
    console.log('  largest curve divergences:');
    for (const ex of curveExamples) console.log(ex);
  }
}

async function main(): Promise<void> {
  logSettings.level = LOGGER_LEVELS.NoLogsOrDebug;
  console.log(`=== Overlap diagnostic: ${CONFIG_NAME} era ${ERA_INDEX} ===`);

  const configDirectory = path.join(process.cwd(), 'config');
  const configs = await readConfigFiles({
    generatorConfig: path.join(configDirectory, `${CONFIG_NAME}.config.yaml`),
    dataSourceConfig: path.join(configDirectory, 'global', 'data-source.config.yaml'),
    glyphConfig: path.join(configDirectory, 'global', 'glyph.config.yaml'),
    systemLabelConfig: path.join(configDirectory, 'global', 'system-label.config.yaml'),
    borderLabelConfig: path.join(configDirectory, 'global', 'border-label.config.yaml'),
  });
  const { generatorConfig, dataSourceConfig } = configs;
  const local = dataSourceConfig.localFileConfig!;
  const resolvedDir = path.resolve(process.cwd(), local.directory);
  const sheetData = await readFromCsvFiles(
    path.join(resolvedDir, local.systemsFilename),
    local.factionsFilename ? path.join(resolvedDir, local.factionsFilename) : undefined,
    local.descriptionFilename ? path.join(resolvedDir, local.descriptionFilename) : undefined,
    dataSourceConfig,
  );
  console.log(`systems: ${sheetData.systems.length}, eras: ${sheetData.eras.length}`);

  const era = sheetData.eras.find((e) => e.index === ERA_INDEX);
  if (!era) throw new Error(`era ${ERA_INDEX} not found`);

  const levels = Math.max(...generatorConfig.mapLayers.map((l) => l.elements.borders?.length || 0));
  const t0 = performance.now();
  const { affiliationLevelSections } = await calculateVoronoiBorders(
    sheetData.systems,
    era,
    {
      origin: UNIVERSE_RECT.anchor,
      dimensions: UNIVERSE_RECT.dimensions,
      radius: 30,
      maxSamples: 30,
      seed: 'sarna',
    },
    levels,
  );
  console.log(`calculateVoronoiBorders(${levels} levels): ${Math.round(performance.now() - t0)}ms`);

  const level0 = affiliationLevelSections[0];
  const rawFill = (level0.fillLoops || {}) as Record<string, Array<BorderEdgeLoop>>;
  const groupedRaw = groupBorderLoopsByUpperKey(rawFill);
  console.log(`raw fillLoops keys: ${Object.keys(groupedRaw).length}`);

  // 1. Overlaps on RAW (pre-viewbox) geometry — isolates compute vs render.
  analyze('RAW fillLoops, renderCurves=true', groupedRaw, true, true);

  // 2. Overlaps after the render path's viewbox restriction.
  const layer: any = generatorConfig.mapLayers[0];
  const focus: Point2d = layer.focus?.point || { x: 0, y: 0 };
  const rect = {
    anchor: {
      x: focus.x - (layer.focus?.delta?.x || 0) - layer.mapUnitDimensions.width * 0.5,
      y: focus.y - (layer.focus?.delta?.y || 0) - layer.mapUnitDimensions.height * 0.5,
    },
    dimensions: layer.mapUnitDimensions,
  };
  const bounded = restrictBorderLoopsToViewbox(rawFill, rect, 15);
  const groupedBounded = groupBorderLoopsByUpperKey(bounded);
  analyze('BOUNDED fillLoops (render path), renderCurves=true', groupedBounded, true, true);

  // 3. Same bounded geometry with curves off — isolates bezier divergence.
  analyze('BOUNDED fillLoops, renderCurves=false', groupedBounded, false, false);

  // 4. Shared-edge control point divergence (the bezier hypothesis).
  checkControlPoints(groupedRaw);
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
