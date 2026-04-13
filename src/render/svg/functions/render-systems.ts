import {
  extractBorderStateAffiliation,
  Faction,
  logger,
  System,
  TextTemplate,
} from '../../../common';
import path from 'path';
import { generateDisputedSystemFillPattern } from './generate-disputed-system-fill-pattern';
import { traceFaction } from '../../../common/utils/faction-traversal-logger';

/**
 * Generates the markup to render out system dots.
 *
 * @param systems The systems list
 * @param factions The list of factions
 * @param theme The render color theme
 * @param eraIndex Index of the era to use
 * @param prefix The prefix string for css and defs
 * @param systemRadius Radius for each system dot
 * @returns The system dots markup
 */
export function renderSystems(
  systems: System[],
  factions: Record<string, Faction>,
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

    const displayedFaction = extractBorderStateAffiliation(
      eraAffiliation,
      [''],
      'faction'
    );

    // ---- TRACE: extracted faction ----
    traceFaction('/src/render/svg/functions/render-systems.ts', 'INPUT extracted-faction', String(displayedFaction));

    const faction = factions[displayedFaction];

    // ---- TRACE: faction resolution ----
    traceFaction('/src/render/svg/functions/render-systems.ts', 'INPUT faction-lookup', String(!!faction));

    const systemIsHidden = !!eraAffiliation.match(/^[^(]+\(H\)(,.+)?$/);

    if (displayedFaction === '') {
      logger.debug('empty faction string for', system.name);
    }

    if (!visibleFactions[displayedFaction]) {
      visibleFactions[displayedFaction] = faction;
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
        css_class: displayedFaction + (systemIsHidden ? ' hidden' : ''),
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
        css_class: displayedFaction,
      });
    }
  });

  let factionCss = '';

  Object.keys(visibleFactions).forEach((factionKey) => {
    const faction = visibleFactions[factionKey];

    // ---- TRACE: CSS generation ----
    traceFaction('/src/render/svg/functions/render-systems.ts', 'css-generation', String(faction?.color));

    if (factionKey === 'U' || factionKey === 'A') {
      return;
    } else if (factionKey === 'D') {
      // handled in default template
    } else if (factionKey.startsWith('D-')) {
      defs += generateDisputedSystemFillPattern(factionKey, factions, defPrefix);
      factionCss += `${cssPrefix}g.systems .system.${factionKey}, g.systems .cluster.${factionKey} { fill: url(#${defPrefix}system-fill-${factionKey}) }\n`;
    } else if (!faction) {
      logger.warn(
        `Cannot find faction for affiliation key "${factionKey}". Systems will be displayed in the default color.`
      );
    } else {
      factionCss += `${cssPrefix}g.systems .system.${factionKey}, g.systems .cluster.${factionKey} { fill: ${faction.color || '#000'} }\n`;
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