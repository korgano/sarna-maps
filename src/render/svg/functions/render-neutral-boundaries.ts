import path from 'path';
import { BorderEdgeLoop } from '../../../compute';
import { System, TextTemplate } from '../../../common';
import { EMPTY_FACTION, INDEPENDENT } from '../../../compute/constants';
import { generateSectionPath } from './generate-section-path';
import { findPocketHoles, groupBorderLoopsByUpperKey, isLoopClosed } from './normalize-border-loops';
import { sanitizeFactionToken } from './sanitize-faction-token';

export interface NeutralBoundariesResult {
  defs: string;
  css: string;
  markup: string;
  clipPathIds: Record<string, string>;
}

/**
 * Generates the neutral boundary layer markup and CSS.
 *
 * STYLE: NEUTRAL BOUNDARY (invisible)
 *   - stroke: none, fill: none
 *   - Used for: Pass 1 clip-path definitions only, never visible on output
 *
 * This is Pass 1 of the two-pass border system: all faction border geometry
 * and disputed zone boundaries are emitted as <clipPath> definitions
 * in <defs>. These clip paths define each faction's territory boundary
 * and are used to clip colored faction borders in Pass 2 (renderBorderLoops),
 * preventing border stroke lines from overlapping at shared boundaries.
 *
 * The neutral boundary markup itself is invisible (stroke: none; fill: none)
 * so it serves purely as a geometric reference without adding visual noise.
 *
 * clip-rule="evenodd" is required: inside <clipPath>, fill-rule is ignored
 * and the default nonzero clip-rule would ADD same-winding hole contours
 * (disputed zones) instead of cutting them, diverging the clip from the
 * evenodd-painted fills.
 */
export function renderNeutralBoundaries(
  borderLoops: Record<string, Array<BorderEdgeLoop>>,
  theme: 'light' | 'dark',
  prefix = '',
  systemsByFaction: Record<string, Array<System>> = {},
): NeutralBoundariesResult {
  const templatePath = path.join(__dirname, '../templates/', theme);
  const layerTemplate = new TextTemplate('element-group.svg.tpl', templatePath);

  const defPrefix = prefix.length ? prefix + '-' : '';
  const cssPrefix = prefix.length ? `.${prefix} ` : '';

  // Case-folded grouping shared with renderBorderLoops.
  const normalizedBorderLoops = groupBorderLoopsByUpperKey(borderLoops);

  // Collect all faction keys (excluding EMPTY_FACTION and INDEPENDENT)
  const allFactionKeys = new Set<string>([
    ...Object.keys(normalizedBorderLoops),
    ...Object.keys(systemsByFaction),
  ]);

  let defs = '';
  let markup = '';
  const clipPathIds: Record<string, string> = {};

  // Generate <clipPath> definitions for each faction's territory
  // and emit invisible neutral boundary paths.
  allFactionKeys.forEach((factionKey) => {
    if (!factionKey || factionKey === EMPTY_FACTION || factionKey === INDEPENDENT) {
      return;
    }

    const safeKey = sanitizeFactionToken(factionKey);
    const clipPathId = `neutral-clip-${defPrefix}${safeKey}`;
    clipPathIds[factionKey] = clipPathId;

    const loopsForFaction = normalizedBorderLoops[factionKey] || [];
    const loopPaths: Array<string> = [];

    const closedLoops = loopsForFaction.filter((borderLoop) => {
      if ([undefined, EMPTY_FACTION].includes(borderLoop.innerAffiliation)) {
        return false;
      }
      // Clip paths require closed contours: open chains and bare viewbox
      // artifacts must not define territory clips.
      return isLoopClosed(borderLoop);
    });
    for (const borderLoop of closedLoops) {
      const pathD = generateSectionPath(borderLoop, true);
      if (pathD.trim()) loopPaths.push(pathD);
    }

    // Pocket holes (foreign pockets AND disputed zones, by geometry) so the
    // clip stays consistent with the territory fills in renderBorderLoops.
    // Disputed factions get holes too (pockets inside disputed zones).
    if (closedLoops.length > 0) {
      const holes = findPocketHoles(closedLoops, normalizedBorderLoops, factionKey);
      for (const hole of holes) {
        const holeD = generateSectionPath(hole, true);
        if (holeD.trim()) loopPaths.push(holeD);
      }
    }

    // Emit <clipPath> definition using the faction's territory boundary paths.
    // clip-rule="evenodd" is required: inside <clipPath>, fill-rule is ignored
    // and the default nonzero clip-rule would ADD same-winding hole contours
    // (disputed zones) instead of cutting them, diverging the clip from the
    // evenodd-painted fills.
    if (loopPaths.length > 0) {
      const clipPathContent = loopPaths.map((d) =>
        `<path clip-rule="evenodd" d="${d}" />`
      ).join('\n');
      defs += `<clipPath id="${clipPathId}">\n${clipPathContent}\n</clipPath>\n`;
    }

    // NOTE: previously we also emitted visible but invisible
    // <path stroke:none; fill:none> elements here as a geometric reference
    // layer. They added DOM nodes without contributing any visible output
    // (the clipPath definitions in <defs> already carry the same geometry
    // for Pass 2 clipping). Removed to reduce SVG file size.
  });

  // CSS only needs to define the neutral-boundaries group; its paths are
  // invisible clip definitions, not rendered geometry.
  const css = `${cssPrefix}g.neutral-boundaries { display: none; }\n`;

  const groupMarkup = layerTemplate.replace({
    name: 'neutral-boundaries',
    css_class: 'neutral-boundaries',
    clip_path: '',
    content: '',
  });

  return {
    defs,
    css,
    markup: groupMarkup,
    clipPathIds,
  };
}
