import path from 'path';

import { BorderEdgeLoop } from '../../../compute';
import { FactionRegistry, logger, System, TextTemplate } from '../../../common';
import { FactionAffiliationPair } from '../../../read/common/retain-faction-affiliation-pairing';
import { EMPTY_FACTION, INDEPENDENT } from '../../../compute/constants';
import { generateSectionPath } from './generate-section-path';
import { isDisputedAffiliation, parseDisputedSubFactions } from '../../../common/utils/disputed-affiliation';
import { groupBorderLoopsByUpperKey, isLoopClosed } from './normalize-border-loops';
import {
  anyRegionCovers,
  buildFillEntries,
  buildFillRegions,
  detectOverlappingRegions,
  FillEntry,
  loopToPoints,
  polylineToPathD,
  trimStrokeAgainstDots,
} from './fill-constraints';
import { traceFaction } from '../../../common/utils/faction-traversal-logger';
import { resolveFactionRenderStyle } from '../types/faction-render-style';
import { sanitizeCssColor } from '../../../common/utils/sanitize-css-color';
import { sanitizeFactionToken } from './sanitize-faction-token';

/**
 * Generates the markup and css to render out borders.
 *
 * ============================================================================
 * SUPPORTED BORDER STROKE STYLES
 * ============================================================================
 *
 * 1. SOLID FACTION BORDER  (this file, applied via .faction-border-<ID>)
 *    - stroke: <faction color>, stroke-width: 1px
 *    - fill: <faction color>, fill-opacity: 0.25 (light) / 0.45 (dark)
 *    - Used for: all faction territory borders (level 0, display === 'factions')
 *    - Each <g> carries data-borderid="<FACTION_KEY>" for CSS/JS targeting,
 *      e.g. [data-borderid="DC"] { stroke: blue; }
 *    - CSS template: border-faction.css.tpl (light + dark variants)
 *
 * 2. DISPUTED BORDER  (fill-only, diagonal half-and-half pattern)
 *    - stroke-width: 0 (no stroke visible)
 *    - Fill is a <pattern> with two faction colors split diagonally
 *    - Used for: disputed territories (D-LC-DC, D-LC|DC, D(CC/FS), etc.)
 *    - Filled via <defs> <pattern> in disputed-faction-fill-def.svg.tpl
 *    - CSS: stroke: transparent, stroke-width: 0, fill: url(#pattern)
 *
 * 3. REGIONAL BORDER  (render-border-sections.ts)
 *    - stroke: #000, stroke-width: 1/level (thinner at deeper levels)
 *    - Used for: region/march boundaries (display === 'regions', levels 1+)
 *
 * 4. CONNECTION LINE  (render-connection-lines.ts)
 *    - stroke: #777 (#aaa dark), stroke-width: 0.05px, stroke-dasharray: 3 1
 *    - Used for: jump/connection lines between nearby systems
 *
 * 5. NEUTRAL BOUNDARY  (render-neutral-boundaries.ts)
 *    - stroke: none, fill: none (invisible)
 *    - Used for: Pass 1 clip-path definitions only, never visible on output
 *
 * Hidden system dots use stroke-dasharray: .4 .3 (system-points.css.tpl).
 * Debug/diagnostic borders use various fixed styles (border-edge, border-label.debug).
 *
 * UNUSED / CONFLICTING STYLES:
 * - render-border-sections.ts uses getRandomColor() for each section —
 *   non-deterministic and not tied to faction colors. Consider removing
 *   or replacing with deterministic faction-based coloring.
 * - No dashed/dotted style is available for faction borders. If needed,
 *   add a stroke-dasharray variant to border-faction.css.tpl.
 *
 * ============================================================================
 * RENDERING ARCHITECTURE (two-pass)
 * ============================================================================
 *
 * Pass 1 (renderNeutralBoundaries): emits invisible <clipPath> definitions
 *   for each faction's territory. The clip geometry comes from the PRE-PULL
 *   fillLoops snapshot (gapless, superset of pulled geometry).
 *
 * Pass 2 (renderBorderLoops): emits visible fills AND strokes from the
 *   SEPARATED (pulled) loops. Both fills and strokes share the same geometry
 *   so a fill never crosses its own border stroke.
 *
 * NO-OVERLAP CONSTRAINT (see fill-constraints.ts):
 *  - fills are built FIRST for every faction and act as the authority:
 *    a border stroke is trimmed wherever it runs through a foreign fill
 *    ("prioritize fills, adjust the stroke")
 *  - a radius disk is only emitted when its system position is NOT already
 *    enclosed by any faction's fill — two fills must never stack
 *
 * Both fills and strokes derive from `generateSectionPath` on the SAME
 * separated loops, so geometry cannot drift between fill and stroke.
 */

export function renderBorderLoops(
  borderLoops: Record<string, Array<BorderEdgeLoop>>,
  fillLoops: Record<string, Array<BorderEdgeLoop>>,
  factionRegistry: FactionRegistry,
  pairs: Map<string, FactionAffiliationPair>,
  theme: 'light' | 'dark',
  renderCurves = true,
  prefix = '',
  systemsByFaction: Record<string, Array<System>> = {},
  clipPathIds: Record<string, string> = {},
) {
  const templatePath = path.join(__dirname, '../templates/', theme);
  const defTemplate = new TextTemplate('disputed-faction-fill-def.svg.tpl', templatePath);
  const cssTemplate = new TextTemplate('border-faction.css.tpl', templatePath);
  const layerTemplate = new TextTemplate('element-group.svg.tpl', templatePath);
  const edgeTemplate = new TextTemplate('border-path.svg.tpl', templatePath);

  let markup = '';
  let css = '';
  let defs = '';

  const defPrefix = prefix.length ? prefix + '-' : '';
  const cssPrefix = prefix.length ? `.${prefix} ` : '';

  // GEOMETRY CONSISTENCY GUARD:
  //   - fillLoops (pre-pull gapless) is the SINGLE source of truth for BOTH
  //     fills and strokes. borderLoops (separated/pulled) must NEVER be used
  //     for fill or stroke rendering — it is compute-only.
  //   - Using different geometry for fills vs strokes causes misaligned
  //     borders, visual gaps, and fill/stroke bleed into neighboring factions.
  //   - Clip paths (Pass 1, renderNeutralBoundaries) confine each faction's
  //     geometry to its own territory using the same fillLoops.
  //
  // See rules/render/pipeline.md "Geometry consistency rules" for details.

  // A disk at the system's configured radius, in render coordinates (y is
  // flipped). Returns '' when the system has no meaningful radius. Emitted as a
  // native SVG <circle> - the previous 64-vertex polygon approximation
  // serialized ~800 bytes per system (~64 x 13-char segments), so a ~700 KB map
  // ballooned to ~3 MB for ~2,500 radius-bearing systems. Circles are a single
  // primitive (~70 bytes), perfectly round, and avoid the evenodd fill-rule
  // cost of thousands of nested contours in one path.
  //
  // NO-OVERLAP: a disk is itself a fill, so it is only emitted while the
  // system position is NOT already enclosed by painted territory — its own
  // faction's fill, a neighbouring faction's fill, or a disputed zone. This
  // keeps the additive disk for genuine single-system enclaves (nothing
  // painted there yet) and drops the redundant second fill everywhere else.
  function radiusBoundedRegionMarkup(system: System): string {
    const r = Math.max(system.radiusX, system.radiusY);
    if (!r || r <= 0) {
      return '';
    }
    if (anyRegionCovers(fillRegions, { x: system.x, y: system.y })) {
      return '';
    }
    return `<circle cx="${system.x.toFixed(3)}" cy="${(-system.y).toFixed(3)}" r="${r.toFixed(3)}" style="stroke: none" />`;
  }

    // FIX: Iterate over ALL factions with systems, not just those with border loops.
  // Case-folded grouping (AuC vs AUC) is shared via groupBorderLoopsByUpperKey.
  // FILLS use normalizedFillLoops (gapless pre-pull geometry) so adjacent
  // territories touch without gaps. STROKES use normalizedBorderLoops
  // (pulled geometry) so parallel border lines keep a hairline gap.
  const normalizedBorderLoops = groupBorderLoopsByUpperKey(borderLoops);
  const normalizedFillLoops = groupBorderLoopsByUpperKey(fillLoops);
  // Sort disputed factions (D-*) last so their fills overlay parent factions,
  // preventing parent faction fills from obscuring disputed zone patterns.
  const allFactionKeys = new Set<string>(
    [...new Set<string>([
      ...Object.keys(normalizedBorderLoops),
      ...Object.keys(normalizedFillLoops),
      ...Object.keys(systemsByFaction),
    ])].sort((a, b) => {
      const aD = /^D[-(]/.test(a) ? 1 : 0;
      const bD = /^D[-(]/.test(b) ? 1 : 0;
      return aD - bD || a.localeCompare(b);
    })
  );
  // PRE-PASS: build every faction's FILL geometry before any markup exists.
  // Fills are the authority for the no-overlap constraint: the disk guard and
  // the stroke trimming below both read these regions, so a stroke or disk is
  // always judged against the fills that will actually be painted.
  const fillEntriesByKey: Record<string, Array<FillEntry>> = {};
  allFactionKeys.forEach((factionKey) => {
    if (!factionKey || factionKey === EMPTY_FACTION || factionKey === INDEPENDENT) {
      return;
    }
    fillEntriesByKey[factionKey] = buildFillEntries(
      factionKey,
      isDisputedAffiliation(factionKey),
      normalizedFillLoops[factionKey] || [],
      normalizedFillLoops,
      renderCurves,
      systemsByFaction,
    );
  });
  const fillRegions = buildFillRegions(fillEntriesByKey);

  // OVERLAP GUARD: detect any pair of faction fills that overlap and log clearly.
  // Never throws — map generation should keep running and the error lands in the
  // warning/error log (and console) so overlaps surface without breaking renders.
  const overlaps = detectOverlappingRegions(fillRegions);
  for (const overlap of overlaps) {
    logger.error(
      'render-border-loops.ts',
      `Faction territory overlap detected: ${overlap.factionA} <-> ${overlap.factionB} (${overlap.detail})`,
    );
  }

  // No cross-faction stroke dedup: separation keeps each faction's copy on
  // its own parallel line, so every faction strokes its full loops in its own
  // color. (A previous revision deduped shared segments globally; that stole
  // the later faction's stroke and split runs into gapped fragments.)
  allFactionKeys.forEach((factionKey) => {
    if (!factionKey || factionKey === EMPTY_FACTION || factionKey === INDEPENDENT) {
      return;
    }

    // --- RESOLVE FACTION RENDER STYLE ---
    const style = resolveFactionRenderStyle({
      factionKey,
      factionRegistry,
      pairs,
    });

    if (!style.faction && style.resolutionStatus === 'no-faction-match') {
      traceFaction(
        'src/render/svg/functions/render-border-loops.ts',
        'missing-faction',
        factionKey
      );
    }

    const safeKey = sanitizeFactionToken(factionKey);

    const isDisputed = isDisputedAffiliation(factionKey);

    if (isDisputed) {
      // Canonical disputed parsing (all forms: D-LC-DC, D-LC|DC, D(CC/FS), D-LC/DC).
      const factionKeys = parseDisputedSubFactions(factionKey);

      if (factionKeys.length >= 1) {
        const faction1 = factionRegistry.get(factionKeys[0]) || null;
        const faction2 = factionKeys.length > 1 ? factionRegistry.get(factionKeys[1]) || null : faction1;

        defs += defTemplate.replace({
          prefix: defPrefix,
          id: safeKey,
          color1: sanitizeCssColor(faction1?.color || '#999999'),
          color2: sanitizeCssColor(faction2?.color || '#999999'),
        });

        if (!faction1) {
          traceFaction(
            'src/render/svg/functions/render-border-loops.ts',
            'missing-disputed-faction',
            factionKeys[0]
          );
        }
        if (factionKeys.length > 1 && !faction2) {
          traceFaction(
            'src/render/svg/functions/render-border-loops.ts',
            'missing-disputed-faction',
            factionKeys[1]
          );
        }

        css += cssTemplate.replace({
          prefix: cssPrefix,
          id: safeKey,
          strokeColor: 'transparent',
          strokeWidth: '0',
          fill: `url(#${defPrefix}border-fill-${safeKey})`,
        });

      } else {
        defs += defTemplate.replace({
          prefix: defPrefix,
          id: 'D',
          color1: '#c86464',
          color2: 'transparent',
        });

        css += cssTemplate.replace({
          prefix: cssPrefix,
          id: safeKey,
          strokeColor: 'transparent',
          strokeWidth: '0',
          fill: `url(#${defPrefix}border-fill-D)`,
        });
      }

    } else {
      css += cssTemplate.replace({
        prefix: cssPrefix,
        id: safeKey,
        strokeColor: sanitizeCssColor(style.color || '#000'),
        strokeWidth: '1px',
        fill: sanitizeCssColor(style.color || '#000'),
      });
    }

    let factionMarkup = '';
    const strokePaths: Array<string> = [];
    // STROKES use the same pre-pull (gapless) geometry as fills so they
    // align perfectly with region borders. Every external border of a faction
    // region has a corresponding stroke that runs flush with adjacent borders.
    // No separate `trimStrokeAgainstRegions` pass is needed: Pass 1 clip paths
    // (render-neutral-boundaries.ts) already confine each faction's fills AND
    // strokes to its own territory, so strokes never spill into neighbours.
    // Only system-dot clearance is applied — strokes must not paint over dots.
    const loopsForFaction = normalizedFillLoops[factionKey] || [];
    if (loopsForFaction.length > 0) {
      logger.debug('render-border-loops.ts', `Faction ${factionKey}: ${loopsForFaction.length} loops, innerAffiliations:`,
        loopsForFaction.map((bl, i) => `[${i}] inner=${bl.innerAffiliation} edges=${bl.edges?.length}`).join(', '));
    }
    // NOTE: no render-time smoothing here. Control points were already
    // generated on the welded pre-separation geometry in
    // calculateVoronoiBorders; a second smoothing pass per faction broke
    // shared-node identity and diverged the neutral/clip layer from the fills,
    // producing non-containment and mismatched punch-holes.
    // Closed loops go to the filled territory path; stranded open chains are
    // stroke-only (fill:none) so they can never produce evenodd fill blobs.
    // STROKES read the SAME pre-pull (gapless) geometry as fills, so every
    // external border has a corresponding stroke following the true shared
    // edge between factions. Strokes stay continuous (no segmentation from
    // foreign-fill trimming) — clip paths handle containment.
    const allDots: Array<{ x: number; y: number; radius: number }> =
      Object.values(systemsByFaction)
        .flat()
        .map((system) => ({
          x: system.x,
          y: system.y,
          radius: Math.max(system.radiusX || 0, system.radiusY || 0),
        }))
        .filter((dot) => dot.radius > 0);
    const strokeClearance = 0.5;
    // Finer curve sampling for dot trimming: bezier curves can bow through a
    // system dot between 8-sampled chords, so use more samples to catch those
    // bows (e.g. Lothan's dot on the DC/CFG frontier).
    const DOT_TRIM_SAMPLES = 32;
    const pushStrokePath = (strokeLoop: BorderEdgeLoop) => {
      // Dot trimming on the original curve with fine sampling: bezier bows
      // through system dots are caught. Trimmed pieces are emitted as separate
      // paths so strokes never paint over system dots.
      const dotSource = renderCurves
        ? loopToPoints(strokeLoop, renderCurves, DOT_TRIM_SAMPLES)
        : loopToPoints(strokeLoop, renderCurves);
      const dotResult = trimStrokeAgainstDots(dotSource, allDots, strokeClearance);
      const dotPieces = dotResult.changed ? dotResult.pieces : [dotSource];

      for (const piece of dotPieces) {
        const pathD = dotResult.changed ? polylineToPathD(piece) : generateSectionPath(strokeLoop, renderCurves);
        if (pathD.trim()) strokePaths.push(pathD);
      }
    };
    for (const borderLoop of loopsForFaction) {
      if ([undefined, EMPTY_FACTION].includes(borderLoop.innerAffiliation)) {
        continue;
      }
      if (!isDisputed && (borderLoop.innerAffiliation || '').toUpperCase() !== factionKey.toUpperCase()) {
        continue;
      }
      if (isDisputed) continue; // fill-only (pattern); parents outline the zone.
      if (isLoopClosed(borderLoop)) {
        pushStrokePath(borderLoop);
      } else {
        // Stranded open chain: drop synthetic viewbox-closure edges (pure
        // frame artifacts) and stroke the remainder (never filled).
        const visibleEdges = borderLoop.edges.filter((e) => !(e as { isInvisible?: boolean }).isInvisible);
        if (visibleEdges.length === 0) continue;
        pushStrokePath({ ...borderLoop, edges: visibleEdges });
      }
    }

    // FILLS: built in the pre-pass so they exist BEFORE any stroke or disk is
    // judged against them. Each entry pairs ONE territory contour with its
    // pocket holes in a single d attribute — evenodd only interacts within
    // one element, so holes must never be emitted as standalone elements
    // (that would FILL them).
    const fillEntries = fillEntriesByKey[factionKey] || [];

    // FIX: Radius-bounded disks previously REPLACED territory fills (loopFill='none')
    // and markup was only emitted when loopPaths>0. This made factions with only
    // r=1 disks appear invisible (tiny 1-unit circles at 0.25 opacity) and
    // factions without loops (single-system enclaves) were dropped entirely.
    // Corrected: disks are additive, territory paths remain filled; emit markup
    // if EITHER disks or loops exist so every faction in the era gets a visible area.
    const factionSystems = isDisputed ? [] : (systemsByFaction[factionKey] || []);
    const boundedRegionMarkup = factionSystems
      .map((system) => radiusBoundedRegionMarkup(system))
      .filter((markup) => markup.length > 0);

    if (boundedRegionMarkup.length > 0) {
      // Filled disks (stroke suppressed inline so the boundary lines stay clean)
      factionMarkup += boundedRegionMarkup.join('\n');
    }

    const fillOpacity = theme === 'dark' ? '0.45' : '0.25';

    if (fillEntries.length > 0) {
      // Territory fills: one <path> per closed loop (fill-only; strokes live
      // in the dedicated stroke paths below). Pocket holes join their parent
      // contour in the same d so evenodd cuts them. Disks are additive
      // overlays, not replacements. Never suppress fill. Paths come from the
      // pre-pass, which is also what the stroke/disk constraints were built
      // from, so markup and geometry can never drift apart.
      for (const entry of fillEntries) {
        const contours = [entry.pathD, ...entry.holePathDs];
        factionMarkup += edgeTemplate.replace({
          d: contours.join(' '),
          stroke: 'none',
          strokeWidth: '1px',
          fill: sanitizeCssColor(style.color || '#000'),
          fillOpacity,
          style: isDisputed ? '' : 'stroke: none',
          meta: '',
        });
      }
    }

    if (strokePaths.length > 0) {
      // Border strokes: globally deduped per physical segment — never filled.
      for (const pathD of strokePaths) {
        factionMarkup += edgeTemplate.replace({
          d: pathD,
          stroke: sanitizeCssColor(style.color || '#000'),
          strokeWidth: '1px',
          fill: 'none',
          fillOpacity,
          style: 'fill: none',
          meta: '',
        });
      }
    }

    // Emit faction layer if we have any visible geometry (disks OR loops).
    // Safeguard: even unknown factions get a fallback color (#999999 via style)
    // instead of being silently skipped.
    if (factionMarkup.trim()) {
      const clipPathId = clipPathIds[factionKey] || clipPathIds[factionKey.toUpperCase()] || '';
      const clipPathAttr = clipPathId ? ` clip-path="url(#${clipPathId})"` : '';
      // data-borderid exposes the parse-systems-v3-csv borderID on the rendered
      // faction group so borders can be styled or queried by a stable identifier
      // (e.g. CSS [data-borderid="DC"], JS document.querySelector('[data-borderid="CFG"]')).
      // factionKey is the upper-cased borderID for level-0 (faction) borders.
      const borderIdAttr = ` data-borderid="${factionKey}"`;
      markup += layerTemplate.replace({
        name: factionKey,
        css_class: 'faction-border-' + safeKey,
        clip_path: clipPathAttr,
        meta: borderIdAttr,
        content: factionMarkup,
      });
    }
  });

  if (markup.trim()) {
    return {
      defs,
      css,
      markup: layerTemplate.replace({
        name: 'borders-layer',
        css_class: 'borders',
        content: markup,
      }),
    };
  }

  return {
    defs: '',
    css: '',
    markup: '',
  };
}