import { GlyphConfig, IdentifiableRectangle, Point2d, Rectangle2d, RectangleGrid } from '../../../common';
import { BorderEdgeLoop } from '../../voronoi-border';
import { sanitizeFactionToken } from '../../../render/svg/functions/sanitize-faction-token';

export interface RegionLabelResult {
  defs: string;
  css: string;
  markup: string;
}

export interface RegionLabelCandidate {
  regionKey: string;
  regionName: string;
  anchor: Point2d;
  width: number;
  height: number;
  score: number;
  color: string;
}

const REGION_LABEL_MIN_DISTANCE = 3;
const REGION_LABEL_PADDING = 0.5;

export function placeRegionLabels(
  borderLoops: Record<string, Array<BorderEdgeLoop>>,
  levelIndex: number,
  factionMap: Record<string, any>,
  labelGrid: RectangleGrid,
  glyphConfig: GlyphConfig,
  viewRect: Rectangle2d,
): RegionLabelResult | null {
  const allCandidates: RegionLabelCandidate[] = [];

  for (const regionKey of Object.keys(borderLoops)) {
    if (regionKey === 'EMPTY' || regionKey === 'I' || regionKey === 'D' || regionKey.startsWith('D-')) continue;
    if (regionKey.endsWith(',Unassigned') || regionKey === 'Unassigned') continue;

    const regionName = extractRegionName(regionKey);
    if (!regionName) continue;

    const loops = borderLoops[regionKey];
    if (!loops || loops.length === 0) continue;

    const labelWidth = measureTextWidth(regionName, glyphConfig);
    const labelHeight = (glyphConfig.borderLabels || glyphConfig.regular).lineHeight;
    const factionColor = getFactionColor(regionKey, factionMap);

    const regionCandidates = findRegionLabelPositions(
      regionKey,
      regionName,
      loops,
      labelWidth,
      labelHeight,
      labelGrid,
      viewRect,
      factionColor,
    );

    for (const candidate of regionCandidates) {
      allCandidates.push(candidate);
      labelGrid.placeItem({
        id: `region-label-${regionKey}-${allCandidates.length}`,
        anchor: {
          x: candidate.anchor.x - candidate.width * 0.5 - REGION_LABEL_PADDING,
          y: candidate.anchor.y - candidate.height * 0.5 - REGION_LABEL_PADDING,
        },
        dimensions: {
          width: candidate.width + REGION_LABEL_PADDING * 2,
          height: candidate.height + REGION_LABEL_PADDING * 2,
        },
      });
    }
  }

  if (allCandidates.length === 0) return null;

  return renderRegionLabels(allCandidates, levelIndex, labelGrid);
}

function extractRegionName(regionKey: string): string | null {
  const parts = regionKey.split(',');
  if (parts.length < 2) return null;
  return parts.slice(1).join(',').trim();
}

function getFactionColor(regionKey: string, factionMap: Record<string, any>): string {
  const factionId = regionKey.split(',')[0];
  const faction = factionMap[factionId] || factionMap[factionId.toUpperCase()];
  return faction?.color || '#666666';
}

function measureTextWidth(text: string, glyphConfig: GlyphConfig): number {
  const settings = glyphConfig.borderLabels || glyphConfig.regular;
  let width = 0;
  for (let i = 0; i < text.length; i++) {
    width += settings.widths[text[i]] || settings.widths.default;
  }
  return width;
}

function findRegionLabelPositions(
  regionKey: string,
  regionName: string,
  loops: BorderEdgeLoop[],
  labelWidth: number,
  labelHeight: number,
  labelGrid: RectangleGrid,
  viewRect: Rectangle2d,
  color: string,
): RegionLabelCandidate[] {
  const candidates: RegionLabelCandidate[] = [];

  for (const loop of loops) {
    const polygon = loop.edges.map((e) => e.node1);
    if (polygon.length < 3) continue;

    const centroid = computeLoopCentroid(loop);
    if (!centroid) continue;
    if (!isPointInPolygon(centroid, polygon)) continue;

    const testRect: Rectangle2d = {
      anchor: {
        x: centroid.x - labelWidth * 0.5 - REGION_LABEL_PADDING,
        y: centroid.y - labelHeight * 0.5 - REGION_LABEL_PADDING,
      },
      dimensions: {
        width: labelWidth + REGION_LABEL_PADDING * 2,
        height: labelHeight + REGION_LABEL_PADDING * 2,
      },
    };

    if (!isInsideViewRect(testRect, viewRect)) continue;
    if (hasOverlap(testRect, labelGrid, regionKey)) continue;

    candidates.push({
      regionKey,
      regionName,
      anchor: centroid,
      width: labelWidth,
      height: labelHeight,
      score: 1,
      color,
    });

    break;
  }

  return candidates;
}

function tooCloseToOtherRegionLabel(
  rect: Rectangle2d,
  placedRects: Rectangle2d[],
  minDist: number,
): boolean {
  for (const placed of placedRects) {
    const dx = (rect.anchor.x + rect.dimensions.width / 2) - (placed.anchor.x + placed.dimensions.width / 2);
    const dy = (rect.anchor.y + rect.dimensions.height / 2) - (placed.anchor.y + placed.dimensions.height / 2);
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < minDist) return true;
  }
  return false;
}

function computeLoopStraightness(loop: BorderEdgeLoop): number {
  if (loop.edges.length < 2) return 0;
  let totalAngleChange = 0;
  for (let i = 1; i < loop.edges.length; i++) {
    const prev = loop.edges[i - 1];
    const curr = loop.edges[i];
    const angle1 = Math.atan2(prev.node2.y - prev.node1.y, prev.node2.x - prev.node1.x);
    const angle2 = Math.atan2(curr.node2.y - curr.node1.y, curr.node2.x - curr.node1.x);
    totalAngleChange += Math.abs(angle2 - angle1);
  }
  return Math.max(0, 1 - totalAngleChange / (Math.PI * loop.edges.length));
}

function computeLocalStraightness(
  edgePath: Array<{ p1: Point2d; p2: Point2d; length: number }>,
  targetDist: number,
  windowSize: number,
): number {
  const halfWindow = windowSize * 0.75;
  let startDist = targetDist - halfWindow;
  let endDist = targetDist + halfWindow;
  const totalLength = edgePath.reduce((s, e) => s + e.length, 0);
  if (startDist < 0) startDist += totalLength;
  if (endDist > totalLength) endDist -= totalLength;

  const points: Point2d[] = [];
  let accumulated = 0;
  for (const edge of edgePath) {
    const edgeStart = accumulated;
    const edgeEnd = accumulated + edge.length;
    if (edgeStart <= startDist && startDist <= edgeEnd) {
      const t = (startDist - edgeStart) / edge.length;
      points.push({
        x: edge.p1.x + (edge.p2.x - edge.p1.x) * t,
        y: edge.p1.y + (edge.p2.y - edge.p1.y) * t,
      });
    }
    if (edgeStart <= targetDist && targetDist <= edgeEnd) {
      const t = (targetDist - edgeStart) / edge.length;
      points.push({
        x: edge.p1.x + (edge.p2.x - edge.p1.x) * t,
        y: edge.p1.y + (edge.p2.y - edge.p1.y) * t,
      });
    }
    if (edgeStart <= endDist && endDist <= edgeEnd) {
      const t = (endDist - edgeStart) / edge.length;
      points.push({
        x: edge.p1.x + (edge.p2.x - edge.p1.x) * t,
        y: edge.p1.y + (edge.p2.y - edge.p1.y) * t,
      });
    }
    accumulated = edgeEnd;
  }

  if (points.length < 3) return 0.5;

  const dx = points[points.length - 1].x - points[0].x;
  const dy = points[points.length - 1].y - points[0].y;
  const chordLen = Math.sqrt(dx * dx + dy * dy);
  const pathLen = endDist - startDist;
  return pathLen > 0 ? Math.min(chordLen / pathLen, 1) : 0;
}

function computeInwardNormal(
  edgePath: Array<{ p1: Point2d; p2: Point2d; length: number }>,
  targetDist: number,
): Point2d {
  let accumulated = 0;
  for (const edge of edgePath) {
    if (accumulated + edge.length >= targetDist) {
      const tx = edge.p2.x - edge.p1.x;
      const ty = edge.p2.y - edge.p1.y;
      const len = Math.sqrt(tx * tx + ty * ty) || 1;
      return { x: -ty / len, y: tx / len };
    }
    accumulated += edge.length;
  }
  return { x: 0, y: 1 };
}

function isPointInPolygon(point: Point2d, polygon: Point2d[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    const intersect = ((yi > point.y) !== (yj > point.y)) &&
      (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function computeLoopCentroid(loop: BorderEdgeLoop): Point2d | null {
  if (!loop.edges.length) return null;
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (const edge of loop.edges) {
    sumX += edge.node1.x + edge.node2.x;
    sumY += edge.node1.y + edge.node2.y;
    count += 2;
  }
  return { x: sumX / count, y: sumY / count };
}

function pointAlongPath(
  edgePath: Array<{ p1: Point2d; p2: Point2d; length: number }>,
  targetDist: number,
): Point2d | null {
  let accumulated = 0;
  for (const edge of edgePath) {
    if (accumulated + edge.length >= targetDist) {
      const t = (targetDist - accumulated) / edge.length;
      return {
        x: edge.p1.x + (edge.p2.x - edge.p1.x) * t,
        y: edge.p1.y + (edge.p2.y - edge.p1.y) * t,
      };
    }
    accumulated += edge.length;
  }
  return null;
}

function isInsideViewRect(rect: Rectangle2d, viewRect: Rectangle2d): boolean {
  const tol = REGION_LABEL_PADDING;
  return (
    rect.anchor.x >= viewRect.anchor.x - tol &&
    rect.anchor.y >= viewRect.anchor.y - tol &&
    rect.anchor.x + rect.dimensions.width <= viewRect.anchor.x + viewRect.dimensions.width + tol &&
    rect.anchor.y + rect.dimensions.height <= viewRect.anchor.y + viewRect.dimensions.height + tol
  );
}

function hasOverlap(
  rect: Rectangle2d,
  labelGrid: RectangleGrid,
  excludeKey: string,
): boolean {
  const testItem: IdentifiableRectangle = {
    id: `region-test-${excludeKey}`,
    anchor: rect.anchor,
    dimensions: rect.dimensions,
  };
  const overlaps = labelGrid.getOverlaps(testItem, 'region-label-');
  return overlaps.length > 0;
}

function renderRegionLabels(
  candidates: RegionLabelCandidate[],
  levelIndex: number,
  labelGrid: RectangleGrid,
): RegionLabelResult {
  let innerMarkup = '';
  const defs = '';
  const css = '';

  for (const candidate of candidates) {
    const safeKey = sanitizeFactionToken(candidate.regionKey);
    innerMarkup += `<text class="region-label level-${levelIndex} ${safeKey}" ` +
      `x="${candidate.anchor.x.toFixed(3)}" ` +
      `y="${(-candidate.anchor.y).toFixed(3)}" ` +
      `text-anchor="middle" ` +
      `alignment-baseline="middle" ` +
      `fill="${candidate.color}">${candidate.regionName}</text>\n`;
  }

  const markup = innerMarkup.trim() > ''
    ? `<g class="region-labels-layer level-${levelIndex}">${innerMarkup}</g>`
    : '';

  return { defs, css, markup };
}

function labelGrid_placeItem(
  labelGrid: RectangleGrid,
  candidate: RegionLabelCandidate,
): void {
  labelGrid.placeItem({
    id: `region-label-${candidate.regionKey}`,
    anchor: {
      x: candidate.anchor.x - candidate.width * 0.5 - REGION_LABEL_PADDING,
      y: candidate.anchor.y - candidate.height * 0.5 - REGION_LABEL_PADDING,
    },
    dimensions: {
      width: candidate.width + REGION_LABEL_PADDING * 2,
      height: candidate.height + REGION_LABEL_PADDING * 2,
    },
  });
}
