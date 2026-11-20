import path from 'path';
import { BorderSection } from '../../../compute';
import { TextTemplate } from '../../../common';
import { generateSectionPath } from './generate-section-path';

/**
 * Deterministic colour for a regional border section, derived from its
 * affiliation pair so repeated runs render identical colours (replaces the
 * previous per-section random colour).
 */
function deterministicColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  const hex = (Math.abs(hash) % 0x1000000).toString(16).padStart(6, '0');
  return `#${hex}`;
}

/**
 * Generates the markup and css to render out borders.
 *
 * STYLE: REGIONAL BORDER
 *   - stroke: #000 (or faction color via regional-border-section-faction.css.tpl)
 *   - stroke-width: 1/level (thinner at deeper hierarchy levels)
 *   - fill: none
 *   - Used for: region/march boundaries (display === 'regions', levels 1+)
 *
 * @param borderSections The map of factions with each faction's borders (one or several border sections per faction)
 * @param theme The render color theme
 * @param renderCurves Whether to render bezier curves (if available) or only straight lines
 */
export function renderBorderSections(
  borderSections: Array<BorderSection>,
  theme: 'light' | 'dark',
  // threeWayNodes: Record<string, Array<string>>,
  // edgeMap: Record<string, VoronoiBorderEdge>,
  renderCurves = true,
) {
  const templatePath = path.join(__dirname, '../templates/', theme);
  const layerTemplate = new TextTemplate('element-group.svg.tpl', templatePath);
  const edgeTemplate = new TextTemplate('border-section.svg.tpl', templatePath);
  let relaxedEdgeMarkup = '';
  let css = '';
  borderSections.forEach((borderSection) => {
    const color = deterministicColor(`${borderSection.affiliation1}|${borderSection.affiliation2}`);
    relaxedEdgeMarkup += edgeTemplate.replace({
      d: generateSectionPath(borderSection, renderCurves),
      // style: `stroke: #a00; fill: none; stroke-width: 1.25`,
      style: `stroke: ${color}; fill: none; stroke-width: 1.25`,
      meta: `data-affiliations="${borderSection.affiliation1}|-|${borderSection.affiliation2}"`,
    });
  });
  const markup =
    layerTemplate.replace({
    name: 'relaxed-edges-layer',
    id: 'relaxed-edges-layer',
    css_class: 'border-sections',
    content: relaxedEdgeMarkup,
  });
  if (markup.trim()) {
    return {
      css,
      markup: layerTemplate.replace({
        name: 'border-sections-layer',
        id: 'border-sections-layer',
        css_class: 'border-sections',
        content: markup,
      }),
    };
  }
  return {
    css: '',
    markup: '',
  };
}
