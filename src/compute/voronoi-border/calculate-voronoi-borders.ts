import { PointWithAffiliation } from '../types';
import {
  BorderDelaunayVertex,
  BorderEdgeLoop, BorderSection,
  VoronoiBorderEdge,
  VoronoiResult,
  VoronoiResultHierarchyLevel
} from './types';
import {
  Era,
  System,
  deepCopy,
  dynamicImport,
  extractBorderStateAffiliation,
  generateVoronoiNodes,
  getAbandonedBorderFaction,
  PoissonDisc,
  PoissonSettings,
  VoronoiCellMode, logger,
} from '../../common';
import Delaunator from 'delaunator';
import {
  generateBorderSections,
  generateBorderEdges,
  simplifyBorderSections,
  connectSalients,
  mergeBorderSections,
  buildCanonicalEdgeControls,
  applyCanonicalEdgeControls,
  generateSimpleBorderLoops,
  generateBorderLoops,
  separateBorderLoops,
  weldLoopJoints,
  calculateSectionLength,
  connectInternalBorderSections,
  clipSectionToLoop,
  validateSystemContainment,
} from './functions';
import { EMPTY_FACTION } from '../constants';
import { getCacheEntryNation, getCacheEntryBorderID, getCacheEntryFactionColor, getCacheEntryVisible } from '../../read/common/retain-faction-affiliation-pairing';

const IRRELEVANT_AFFILIATIONS = ['U', 'A', ''];

// Clan Invasion Zone designations (CIZ1A, CIZ2C, CIZ3B, etc.) are
// faction-region designations that surround and fracture faction territories.
// They are now included in border-relevant Delaunay triangulation so that
// their coordinates participate in Voronoi cell generation and border loops.
// The CIZ_PATTERN is retained for other downstream checks but border
// generation now includes these systems so their territory is properly framed.
const CIZ_PATTERN = /^CIZ\d[A-C]/i;

function isBorderRelevantAffiliation(affiliation: string): boolean {
  if (IRRELEVANT_AFFILIATIONS.includes(affiliation)) return false;
  // CIZ systems are NOW included in triangulation — their coordinates
  // participate in Voronoi cell generation and affect neighboring faction
  // territory shapes. The pattern is still available for other checks.
  return true;
}

interface CachedSystemPoint extends PointWithAffiliation {
  nation: string;
  borderID: string;
  factionColor: string;
}

interface SystemPointCache {
  points: CachedSystemPoint[] | null;
  count: number;
  eraIndex: number;
}

function getSystemPoints(systems: System[], era: Era, cache: SystemPointCache): PointWithAffiliation[] {
  if (cache.points && cache.count === systems.length && cache.eraIndex === era.index) {
    return cache.points;
  }
  cache.points = systems
    .map((system) => {
      const cacheKey = `${system.id}_${era.index}`;
      // Trim: downstream keys are case/whitespace-folded at render time, so
      // leading/trailing whitespace here would orphan a faction's sections.
      const nation = (system.eraAffiliations[era.index] || getCacheEntryNation(cacheKey) || '').trim();
      // A(<FACTION>) = abandoned system within <FACTION>'s border: seed the
      // Voronoi as <FACTION> (v3 borderID) while dots/labels stay abandoned.
      // Bare A keeps its raw form and is filtered out below, like U.
      const abandonedBorderFaction = getAbandonedBorderFaction(nation);
      const borderAffiliation = abandonedBorderFaction
        ? nation.replace(/^A\s*\(([^)]+)\)/i, '$1')
        : nation;
      const borderID = (getCacheEntryBorderID(cacheKey) || borderAffiliation).trim();
      const visible = getCacheEntryVisible(cacheKey);
      const affiliation = visible ? borderID : '';
      return {
        id: system.id,
        x: system.x,
        y: system.y,
        affiliation,
        nation,
        borderID,
        factionColor: getCacheEntryFactionColor(cacheKey),
      };
    })
    .filter((p) => isBorderRelevantAffiliation(
      extractBorderStateAffiliation(p.affiliation)
    ));
  cache.count = systems.length;
  cache.eraIndex = era.index;
  return cache.points;
}

export async function calculateVoronoiBorders(
  systems: Array<System>,
  era: Era,
  poissonSettings: Partial<PoissonSettings> = {},
  affiliationLevels: number,
  // Per-side map-unit offset; the shared border reads as two parallel lines
  // with a total visual gap of 2 x borderSeparation x 0.5 map units. Must
  // exceed the 1px border stroke at zoom ~1, or parallels blur into a
  // "doubled" band — hence 1.0, not 0.5. (No config surface by design.)
  borderSeparation = 1.0,
  controlPointTension = 0.35,
  cellMode: VoronoiCellMode = VoronoiCellMode.Circumcenters,
): Promise<VoronoiResult> {
  const Delaunator = (await dynamicImport('delaunator')).default;
  // generate noise points for anything outside the actual borders
  const defaultPoissonPoint: PointWithAffiliation = {
    id: 'poisson-point',
    x: 0,
    y: 0,
    affiliation: EMPTY_FACTION,
  };
  const poissonDisc = new PoissonDisc<PointWithAffiliation>(poissonSettings, defaultPoissonPoint).run();

  // If no affiliation levels are required, do not perform any calculations
  if (affiliationLevels <= 0) {
    return {
      poissonDisc,
      delaunayVertices: [],
      delaunayTriangles: [],
      voronoiNodes: [],
      affiliationLevelSections: [],
      salientPoints: [],
    };
  }

  // add a special reserved point next to Sol, because the distance to Rigil Kentarus is so small
  const terra = systems.find((system) => system.name === 'Sol');
  // borderID, not nation: enrichment's `nation` is the bare first token, which
  // would drop the hierarchy tail that multi-level borders read off the sol
  // buffer points. borderID is the A(F)-unwrapped cell with its tail intact —
  // the same value the per-system points seed with above (line 83). The
  // A-unwrap below stays: it is idempotent on borderID and still applies when
  // falling back to the raw era cell (empty cache).
  const solRawAffiliation = terra ? (getCacheEntryBorderID(`${terra.id}_${era.index}`) || terra.eraAffiliations[era.index] || '') : '';
  const solAbandonedBorderFaction = getAbandonedBorderFaction(solRawAffiliation);
  const solAffiliation = solAbandonedBorderFaction
    ? solRawAffiliation.replace(/^A\s*\(([^)]+)\)/i, '$1')
    : solRawAffiliation;

  // voronoi calculation for all affiliation levels
  const systemPointCache: SystemPointCache = { points: null, count: 0, eraIndex: -1 };

  let voronoiResult: VoronoiResult = performVoronoiCalculations(
    Delaunator,
    cellMode,
    poissonDisc,
    systems,
    systemPointCache,
    [],
    era,
    affiliationLevels,
    solAffiliation,
  );

  // figure out salients (top level only)
  const simpleBorderLoops = generateSimpleBorderLoops(
    voronoiResult.affiliationLevelSections[0].borderSections,
    voronoiResult.delaunayVertices,
  );
  const salientPoints = connectSalients(simpleBorderLoops, voronoiResult.delaunayVertices);
  if (salientPoints.length) {
    // re-run the voronoi calculations with the additional salient points
    voronoiResult = performVoronoiCalculations(
      Delaunator,
      cellMode,
      poissonDisc,
      systems,
      systemPointCache,
      salientPoints,
      era,
      affiliationLevels,
      solAffiliation,
    );
  }

  // entity borders map, by hierarchy level
  const borderLoops: Array<Record<string, Array<BorderEdgeLoop>>> = [];

  // go through each of the hierarchy levels
  voronoiResult.affiliationLevelSections.forEach((hierarchyLevel, hierarchyLevelIndex) => {
    logger.debug('Calculating voronoi borders: Now working on hierarchy level', hierarchyLevelIndex);
    // keep a copy of the original border edges array
    hierarchyLevel.unmodifiedBorderEdges = deepCopy(hierarchyLevel.borderEdges);

    // merge smaller border sections into larger ones
    mergeBorderSections(hierarchyLevel.borderSections, hierarchyLevelIndex);
    // simplify border sections by removing short edges and straightening the edge flow
    // TODO differentiate amount of simplification by hierarchy level?
    simplifyBorderSections(
      hierarchyLevel.borderSections,
      voronoiResult.delaunayVertices,
      hierarchyLevel.threeWayNodes
    );

    // create a map with key = edge id
    const edgeMap: Record<string, VoronoiBorderEdge> = {};
    hierarchyLevel.borderSections.forEach((borderSection) => {
      borderSection.edges.forEach((edge) => edgeMap[edge.id] = edge)
    })

    const borderSectionsForLoops = deepCopy(hierarchyLevel.borderSections);

    // Match sections to parent loop
    if (hierarchyLevelIndex === 0) {
      hierarchyLevel.internalBorderSections = [];
    } else {
      const candidateSections = hierarchyLevel.borderSections.filter((section) => {
        const parentAffiliation1 = section.affiliation1.split(',').slice(0, hierarchyLevelIndex).join(',');
        const parentAffiliation2 = section.affiliation2.split(',').slice(0, hierarchyLevelIndex).join(',');
        return parentAffiliation1 === parentAffiliation2;
      });

      const parentLevelIndex = hierarchyLevelIndex - 1;
      const parentLoops =
        voronoiResult.affiliationLevelSections[parentLevelIndex].borderLoops || {};

      const keptSections = candidateSections.filter((section) => {
        const parentAff =
          section.affiliation1.split(',').slice(0, hierarchyLevelIndex).join(',');
        const loops = parentLoops[parentAff];
        if (!loops || loops.length === 0) {
          return false;
        }

        const mainLoop = loops[0];
        const { keep } = clipSectionToLoop(section, mainLoop.edges.map((e) => e.node1));
        return keep;
      });

      hierarchyLevel.internalBorderSections = keptSections;

      connectInternalBorderSections(
        hierarchyLevelIndex,
        hierarchyLevel.internalBorderSections,
        voronoiResult.affiliationLevelSections.map(
          (section) => section.borderLoops || {}
        ),
      );
    }

    // create edge loops for each entity in this hierarchy level
    hierarchyLevel.borderLoops = generateBorderLoops(borderSectionsForLoops, voronoiResult.delaunayVertices);

    // Weld junctions BEFORE control points so curves derive from continuous
    // geometry (see weldLoopJoints).
    weldLoopJoints(hierarchyLevel.borderLoops);

    // Build an edge map from the loops for control point generation.
    const loopEdgeMap: Record<string, VoronoiBorderEdge> = {};
    for (const affiliation of Object.keys(hierarchyLevel.borderLoops)) {
      const loops = hierarchyLevel.borderLoops[affiliation];
      for (let i = 0; i < loops.length; i++) {
        const loop = loops[i];
        for (let j = 0; j < loop.edges.length; j++) {
          const edge = loop.edges[j];
          if (!loopEdgeMap[edge.id]) { loopEdgeMap[edge.id] = edge }
        }
      }
    }

    // Generate canonical, edge-centric control points once per shared edge, then
    // write the identical values onto every faction's clone. Both sides of a
    // shared border therefore paint one identical bezier curve — no lensing at
    // three-way junctions. Interior chains compute exactly what they computed
    // before; junction handles become symmetric by construction.
    const canonicalControls = buildCanonicalEdgeControls(loopEdgeMap);
    applyCanonicalEdgeControls(hierarchyLevel.borderLoops, canonicalControls, loopEdgeMap);

    // Gapless territory snapshot for FILLS, taken BEFORE separation: adjacent
    // fills meet at shared centerlines with no background slivers. Strokes
    // keep the separated (pulled) geometry so shared borders read as two
    // parallel faction-colored lines instead of one coincident overdraw.
    hierarchyLevel.fillLoops = deepCopy(hierarchyLevel.borderLoops);

    const separationTension = borderSeparation * 0.5;

    // Pull each faction's copy toward its own systems (stroke geometry only).
    // Pull direction is ownership-aware (geometric system vote, not the forced
    // innerAffiliation), so pocket rings retreat from foreign interiors
    // instead of converging onto the pocket owner's line.
    separateBorderLoops(hierarchyLevel.borderLoops, voronoiResult.delaunayVertices, separationTension);

    Object.keys(hierarchyLevel.borderLoops).forEach((affiliation) => {
      // we do not need additional higher-level loops, those can be filtered out
      if (affiliation.split(',').length < hierarchyLevelIndex + 1) {
        delete hierarchyLevel.borderLoops![affiliation];
        delete hierarchyLevel.fillLoops![affiliation];
        return;
      }
      hierarchyLevel.borderLoops![affiliation].forEach((loop) => {
        calculateSectionLength(loop);
        (loop as BorderEdgeLoop).isInnerLoop = loop.innerAffiliation !== affiliation;
      });
    });
  });

  const topLevel = voronoiResult.affiliationLevelSections[0];

  // Validate system containment against the FILL geometry (what the user sees
  // as territory). Mis-contained systems indicate winding/orientation bugs.
  if (topLevel?.fillLoops) {
    validateSystemContainment(
      topLevel.fillLoops,
      systems,
      era.index,
    );
  }

  // Validate against the SEPARATED (rendered) border loops, not just the
  // pre-separation fill snapshot. Separation can pull borders past own-faction
  // edge systems, ejecting them from their own territory. This check catches
  // that regression at generation time rather than visually.
  if (topLevel?.borderLoops) {
    validateSystemContainment(
      topLevel.borderLoops,
      systems,
      era.index,
    );
  }

  return {
    ...voronoiResult,
    salientPoints,
  };
}

/**
 * Helper function that executes everything prior to the merge / simplify steps.
 * This includes delaunay triangulation, constructing the voronoi diagram,
 * finding border edges and constructing sections.
 *
 * May be executed multiple times.
 *
 * @param Delaunator The Delaunator instance
 * @param cellMode Voronoi cell mode to use
 * @param poissonDisc The poisson disc instance
 * @param systems The list of systems
 * @param salientPoints The list of salient points
 * @param era The era to use
 * @param affiliationLevels The number of hierarchy levels to generate border sections for
 * @param solAffiliation The affiliation of the sol system in the given era
 */
type DelaunayFactory = typeof Delaunator;
type DelaunayTriangulation = Delaunator<[number, number]>;

function performVoronoiCalculations(
  Delaunator: DelaunayFactory,
  cellMode: VoronoiCellMode,
  poissonDisc: PoissonDisc<PointWithAffiliation>,
  systems: Array<System>,
  systemPointCache: SystemPointCache,
  salientPoints: Array<PointWithAffiliation>,
  era: Era,
  affiliationLevels: number,
  solAffiliation: string,
): VoronoiResult {
  poissonDisc.replaceReservedPoints([
    ...getSystemPoints(systems, era, systemPointCache),
    ...salientPoints,
    {id: 'sol-buffer-point-1', x: 1, y: 3, affiliation: solAffiliation},
    {id: 'sol-buffer-point-2', x: 2.5, y: -1.25, affiliation: solAffiliation},
  ]);

  // filter out points that are irrelevant for drawing the borders, then add an empty adjacency list to each relevant point
  // (top-level affiliations only)
  const delaunayVertices: Array<BorderDelaunayVertex> = poissonDisc.aggregatedPoints
    .filter((poissonPoint) =>  isBorderRelevantAffiliation(
      extractBorderStateAffiliation(poissonPoint.affiliation)
    ))
    .map((poissonPoint) => ({ ...poissonPoint, adjacentTriIndices: [] }));
  // run delaunay triangulation (using the delaunator library)
  const delaunay = Delaunator.from(delaunayVertices.map((vertex) => [vertex.x, vertex.y]));
  // TODO are these really needed, or are they just for visual debugging?
  //   In that case, maybe it's enough to pass the delaunay object
  const delaunayTriangles: Array<[BorderDelaunayVertex, BorderDelaunayVertex, BorderDelaunayVertex]> = [];
  for (let i = 0; i < delaunay.triangles.length; i += 3) {
    delaunayTriangles.push([
      delaunayVertices[delaunay.triangles[i]],
      delaunayVertices[delaunay.triangles[i + 1]],
      delaunayVertices[delaunay.triangles[i + 2]],
    ]);
  }
  // create the voronoi nodes based on the triangulation
  // @types/delaunator's `from` returns Delaunator<Float64Array> while downstream
  // consumers type the diagram as Delaunator<[number, number]>; bridge the
  // generic variance here rather than widening the shared signature.
  const voronoiNodes = generateVoronoiNodes(delaunay as unknown as DelaunayTriangulation, delaunayVertices, cellMode).map((node) => ({
    ...node,
    borderAffiliations: {},
  }));
  // for each level of borders that needs to be displayed, generate border edges and assemble them to sections
  const affiliationLevelSections: Array<VoronoiResultHierarchyLevel> = [];
  for (let levels = 0; levels < affiliationLevels; levels++) {
    // process the voronoi nodes and generate border edges for the hierarchy level entities (e.g. factions)
    const { borderEdges, threeWayNodes } = generateBorderEdges(
      voronoiNodes,
      delaunayVertices,
      levels + 1,
    );
    // using the border edges, create border sections
    const borderSections = generateBorderSections(borderEdges);
    // add the section objects for the current affiliation hierarchy level
    affiliationLevelSections.push({
      borderEdges,
      threeWayNodes,
      borderSections,
    });
  }

  return {
    delaunayVertices,
    delaunayTriangles,
    poissonDisc,
    voronoiNodes,
    affiliationLevelSections,
  };
}
