import path from 'path';

import { BorderEdgeLoop } from '../../../compute';
import { Faction, TextTemplate } from '../../../common';
import { FactionAffiliationPair } from '../../../read/common/retain-faction-affiliation-pairing';
import { EMPTY_FACTION, INDEPENDENT } from '../../../compute/constants';
import { generateSectionPath } from './generate-section-path';
import { traceFaction } from '../../../common/utils/faction-traversal-logger';
import { resolveFactionRenderStyle, FactionRenderStyle } from '../types/faction-render-style';

/**
 * Generates the markup and css to render out borders.
 */
export function renderBorderLoops(
  borderLoops: Record<string, Array<BorderEdgeLoop>>,
  factions: Record<string, Faction>,
  pairs: Map<string, FactionAffiliationPair>,
  theme: 'light' | 'dark',
  renderCurves = true,
  prefix = '',
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

  Object.keys(borderLoops).forEach((factionKey) => {
    if (!factionKey || factionKey === EMPTY_FACTION || factionKey === INDEPENDENT) {
      return;
    }

    // --- RESOLVE FACTION RENDER STYLE ---
    const style = resolveFactionRenderStyle({
      factionKey,
      factionMap: factions,
      pairs,
    });

    if (!style.faction && style.resolutionStatus === 'no-faction-match') {
      traceFaction(
        'src/render/svg/functions/render-border-loops.ts',
        'missing-faction',
        factionKey
      );
    }

    if (factionKey === 'D' || factionKey.startsWith('D-')) {
      const factionKeys = factionKey.replace(/^D-/g, '').split('-');

      if (factionKeys.length === 2) {
        const faction1 = factions[factionKeys[0]] || (style.disputedFactionIds[0] ? { color: style.color } : null);
        const faction2 = factions[factionKeys[1]] || (style.disputedFactionIds[1] ? { color: style.color } : null);

        defs += defTemplate.replace({
          prefix: defPrefix,
          id: factionKey,
          color1: faction1?.color || style.disputedFactionIds[0] ? '#999999' : '#c86464',
          color2: faction2?.color || style.disputedFactionIds[1] ? '#999999' : '#c86464',
        });

        // Trace missing sub-factions
        if (!faction1) {
          traceFaction(
            'src/render/svg/functions/render-border-loops.ts',
            'missing-disputed-faction',
            factionKeys[0]
          );
        }
        if (!faction2) {
          traceFaction(
            'src/render/svg/functions/render-border-loops.ts',
            'missing-disputed-faction',
            factionKeys[1]
          );
        }

        // Add CSS for the disputed pattern
        css += cssTemplate.replace({
          prefix: cssPrefix,
          id: factionKey,
          strokeColor: 'transparent',
          strokeWidth: '0',
          fill: `url(#${defPrefix}border-fill-${factionKey})`,
        });

      } else {
        // FALLBACK: use generic 'D' pattern without reassigning factionKey
        defs += defTemplate.replace({
          prefix: defPrefix,
          id: 'D',
          color1: '#c86464',
          color2: 'transparent',
        });

        // Use 'D' as the pattern reference for CSS when falling back
        css += cssTemplate.replace({
          prefix: cssPrefix,
          id: factionKey,
          strokeColor: 'transparent',
          strokeWidth: '0',
          fill: `url(#${defPrefix}border-fill-D)`,
        });
      }

    } else {
      css += cssTemplate.replace({
        prefix: cssPrefix,
        id: factionKey,
        strokeColor: style.color || '#000',
        strokeWidth: '1px',
        fill: style.color || '#000',
      });
    }

    let factionMarkup = '';
    const loopPaths: Array<string> = [];
    let loopAffiliations = '';

    borderLoops[factionKey].forEach((borderLoop) => {
      if ([undefined, EMPTY_FACTION].includes(borderLoop.innerAffiliation)) {
        return;
      }

      // --- TRACE ---
      const edge = { faction: factionKey };
      traceFaction(
        'src/render/svg/functions/render-border-loops.ts',
        'border-loop',
        edge.faction
      );

      loopAffiliations += borderLoop.innerAffiliation + ',';
      loopPaths.push(generateSectionPath(borderLoop, renderCurves));
    });

    if (loopPaths.length > 0) {
      factionMarkup += edgeTemplate.replace({ d: loopPaths.join(' ') });
    }

    markup += layerTemplate.replace({
      name: factionKey,
      css_class: 'faction-border-' + factionKey,
      content: factionMarkup,
    });
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