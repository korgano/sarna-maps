import {
  extractBorderStateAffiliation,
  Faction,
  logger,
  System,
  TextTemplate,
} from '../../../common';
import { FactionAffiliationPair } from '../../../read/common/retain-faction-affiliation-pairing';
import path from 'path';
import { generateDisputedSystemFillPattern } from './generate-disputed-system-fill-pattern';
import { traceFaction } from '../../../common/utils/faction-traversal-logger';
import { resolveFactionRenderStyle, FactionRenderStyle } from '../types/faction-render-style';

/**
 * Generates the markup to render out system dots.
 *
 * @param systems The systems list
 * @param factions The list of factions
 * @param pairs The faction affiliation pairs map for render pipeline
 * @param theme The render color theme
 * @param eraIndex Index of the era to use
 * @param prefix The prefix string for css and defs
 * @param systemRadius Radius for each system dot
 * @returns The system dots markup
 */
export function renderSystems(
  systems: System[],
  factions: Record<string, Faction>,
  pairs: Map<string, FactionAffiliationPair>,
  theme: 'light' | 'dark',
  eraIndex = 0,
  prefix = '',
  systemRadius = 1,
) {
  const templatePath = path.join(__dirname, '../templates/', theme);
  const cssTemplate = new TextTemplate('system-points.css.tpl', templatePath);
  const layerTemplate = new TextTemplate('element-group.svg.tpl', templatePath);
  const systemTemplate = new TextTemplate('system-point.svg.tpl', templatePath);
  const capitalDecorationTemplate = new TextTemplate('system-decoration.svg.tpl', templatePath);
  const clusterTemplate = new TextTemplate('cluster-ellipse.svg.tpl', templatePath);

  const visibleFactions: Record<string, Faction> = {};
  const factionStyles: Record<string, FactionRenderStyle> = {};

  let markup = '';
  let defs = '';
  const defPrefix = prefix.length ? prefix + '-' : '';
  const cssPrefix = prefix.length ? `.${prefix} ` : '';

  systems.forEach((system) => {
    const eraName = system.eraNames[eraIndex] || '';
    const eraCapitalLevel = system.eraCapitalLevels[eraIndex] || 0;
    const eraAffiliation = system.eraAffiliations[eraIndex] || '';

    // ---- TRACE: raw affiliation ----
    traceFaction('/src/render/svg/functions/render-systems.ts', 'INPUT raw-affiliation', String(eraAffiliation));

    let displayedFaction = extractBorderStateAffiliation(
      eraAffiliation,
      ['', 'U'], // Keep default ignored affiliations
      'faction',
      undefined,
      undefined,
      system.id,
      eraIndex
    );

    // ---- TRACE: extracted faction ----
    traceFaction('/src/render/svg/functions/render-systems.ts', 'INPUT extracted-faction', String(displayedFaction));

    // Resolve faction render style using pairs data (preferred) with factionMap fallback
    const style = resolveFactionRenderStyle({
      systemId: system.id,
      eraIndex,
      factionKey: displayedFaction,
      factionMap: factions,
      pairs,
    });

    // Sync displayedFaction with the resolved style to avoid divergence
    // (pair lookup may return a different normalized affiliation)
    displayedFaction = style.factionKey;

    // ---- TRACE: faction resolution ----
    traceFaction('/src/render/svg/functions/render-systems.ts', 'INPUT faction-lookup', String(!!style.faction));

    const systemIsHidden = !!eraAffiliation.match(/^[^(]+\(H\)(,.+)?$/);
    const systemIsAbandoned = !!eraAffiliation.match(/^A/);

    if (displayedFaction === '') {
      logger.debug('empty faction string for', system.name);
    }

    if (!visibleFactions[displayedFaction] && style.faction) {
      visibleFactions[displayedFaction] = style.faction;
    }

    // Store style for CSS generation (use first system's style per factionKey)
    if (!factionStyles[displayedFaction]) {
      factionStyles[displayedFaction] = style;
    }

    if (!system.isCluster) {
      if (eraCapitalLevel > 0 && eraCapitalLevel <= 2) {
        markup += capitalDecorationTemplate.replace({
          x: system.x.toFixed(3),
          y: (-system.y).toFixed(3),
          radius: systemRadius * 1.5,
          name: eraName,
        });
      }

      if (eraCapitalLevel === 1) {
        markup += capitalDecorationTemplate.replace({
          x: system.x.toFixed(3),
          y: (-system.y).toFixed(3),
          radius: systemRadius * 2,
          name: eraName,
        });
      }

      markup += systemTemplate.replace({
        x: system.x.toFixed(3),
        y: (-system.y).toFixed(3),
        radius: systemRadius,
        name: eraName,
        css_class: displayedFaction + (systemIsHidden ? ' hidden' : '') + (systemIsAbandoned ? ' abandoned' : ''),
      });

      if (eraCapitalLevel > 0) {
        markup += capitalDecorationTemplate.replace({
          x: system.x.toFixed(3),
          y: (-system.y).toFixed(3),
          radius: systemRadius * 0.15,
          name: eraName,
        });
      }
    } else {
      markup += clusterTemplate.replace({
        x: system.x.toFixed(3),
        y: (-system.y).toFixed(3),
        rx: system.radiusX,
        ry: system.radiusY,
        name: eraName,
        css_class: displayedFaction + (systemIsAbandoned ? ' abandoned' : ''),
      });
    }
  });

  let factionCss = '';

  Object.keys(visibleFactions).forEach((factionKey) => {
    const faction = visibleFactions[factionKey];
    const style = factionStyles[factionKey];

    // ---- TRACE: CSS generation ----
    traceFaction('/src/render/svg/functions/render-systems.ts', 'css-generation', String(style?.color));

    if (factionKey === 'U' || factionKey === 'A') {
      return;
    } else if (factionKey === 'D') {
      // handled in default template
    } else if (factionKey.startsWith('D-')) {
      defs += generateDisputedSystemFillPattern(factionKey, factions, defPrefix, style);
      factionCss += `${cssPrefix}g.systems .system.${factionKey}, g.systems .cluster.${factionKey} { fill: url(#${defPrefix}system-fill-${factionKey}) }\n`;
    } else if (!faction && style?.resolutionStatus === 'no-faction-match') {
      // Use default gray color for missing factions (resolved via pairing data)
      factionCss += `${cssPrefix}g.systems .system.${factionKey}, g.systems .cluster.${factionKey} { fill: ${style.color} }\n`;
    } else if (!faction) {
      logger.warn(
        'render-systems.ts',
        `Cannot find faction for affiliation key "${factionKey}". Systems will be displayed in the default color.`
      );
    } else {
      factionCss += `${cssPrefix}g.systems .system.${factionKey}, g.systems .cluster.${factionKey} { fill: ${faction.color || style?.color || '#999999'} }\n`;
    }
  });

  if (markup.trim()) {
    return {
      defs,
      css: cssTemplate.replace({
        prefix: cssPrefix,
        faction_colors: factionCss,
      }),
      markup: layerTemplate.replace({
        name: 'systems-dots-layer',
        id: 'systems-dots-layer',
        css_class: 'systems',
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