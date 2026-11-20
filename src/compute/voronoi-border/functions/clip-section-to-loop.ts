import { BorderSection, VoronoiBorderNode } from '../types';

function pointInPolygon(px: number, py: number, loop: Array<{ x: number; y: number }>) {
  let inside = false;
  const n = loop.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = loop[i].x, yi = loop[i].y;
    const xj = loop[j].x, yj = loop[j].y;
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function samplePointsFromSection(section: BorderSection): Array<{ x: number; y: number }> {
  if (section.edges.length === 0) return [];
  const samples: Array<{ x: number; y: number }> = [];
  if (section.edges[0].node1) {
    samples.push({ x: section.edges[0].node1.x, y: section.edges[0].node1.y });
  }
  const last = section.edges[section.edges.length - 1];
  if (last.node2) {
    samples.push({ x: last.node2.x, y: last.node2.y });
  }
  // If more than two edges, add a midpoint as extra validation.
  if (section.edges.length >= 3) {
    const mid = section.edges[Math.floor(section.edges.length / 2)];
    if (mid.node2) {
      samples.push({ x: mid.node2.x, y: mid.node2.y });
    }
  }
  return samples;
}

/**
 * Clips a single section’s edges to the parent loop using Sutherland-Hodgman
 * on the polygon defined by the edge vertices.
 */
type OriginalVertex = { x: number; y: number; edgeIdx: number };
type IntersectionVertex = { x: number; y: number };
type ClippingVertex = OriginalVertex | IntersectionVertex;

function isOriginal(v: ClippingVertex): v is OriginalVertex {
  return "edgeIdx" in v && typeof (v as OriginalVertex).edgeIdx === "number";
}

function clipSectionEdgesToLoop(section: BorderSection, parentLoop: Array<VoronoiBorderNode>) {
  if (parentLoop.length < 3) return section;

  const polygon: Array<OriginalVertex> = [];
  section.edges.forEach((edge, idx) => {
    polygon.push({ x: edge.node1.x, y: edge.node1.y, edgeIdx: idx });
    polygon.push({ x: edge.node2.x, y: edge.node2.y, edgeIdx: idx });
  });

  let inputList: Array<ClippingVertex> = polygon;
  for (let i = 0, n = parentLoop.length; i < n; i++) {
    const j = (i + 1) % n;
    const cp1 = parentLoop[i];
    const cp2 = parentLoop[j];
    const outputList: Array<ClippingVertex> = [];
    if (inputList.length === 0) break;

    for (let k = 0; k < inputList.length; k++) {
      const curr = inputList[k];
      const prev = inputList[(k + inputList.length - 1) % inputList.length];

      const currInside = pointInPolygonOnEdge(curr, cp1, cp2);
      const prevInside = pointInPolygonOnEdge(prev, cp1, cp2);

      if (currInside) {
        if (!prevInside) {
          const inter = intersectSegments(prev, curr, cp1, cp2);
          if (inter) {
            outputList.push(inter);
          }
        }
        outputList.push(curr);
      } else if (prevInside) {
        const inter = intersectSegments(prev, curr, cp1, cp2);
        if (inter) {
          outputList.push(inter);
        }
      }
    }

    inputList = outputList;
  }

  if (inputList.length < 2) {
    section.edges = [];
    return section;
  }

  const newEdges: Array<typeof section.edges[0]> = [];
  for (let i = 0; i < inputList.length - 1; i++) {
    const a = inputList[i];
    const b = inputList[i + 1];

    if (
      isOriginal(a) &&
      isOriginal(b) &&
      a.edgeIdx === b.edgeIdx
    ) {
      const orig = section.edges[a.edgeIdx];
      if (orig) {
        orig.node1.x = a.x;
        orig.node1.y = a.y;
        orig.node2.x = b.x;
        orig.node2.y = b.y;
        newEdges.push(orig);
        continue;
      }
    }

    const template = section.edges[0];
    if (template) {
      const edge = {
        ...template,
        node1: { x: a.x, y: a.y },
        node2: { x: b.x, y: b.y },
      };
      newEdges.push(edge as typeof template);
    }
  }

  section.edges = newEdges;
  return section;
}

function pointInPolygonOnEdge(
  p: { x: number; y: number },
  cp1: { x: number; y: number },
  cp2: { x: number; y: number },
) {
  const cross = (cp2.x - cp1.x) * (p.y - cp1.y) - (cp2.y - cp1.y) * (p.x - cp1.x);
  return cross >= 0;
}

function intersectSegments(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  q1: { x: number; y: number },
  q2: { x: number; y: number },
): { x: number; y: number } | undefined {
  const dx1 = p2.x - p1.x, dy1 = p2.y - p1.y;
  const dx2 = q2.x - q1.x, dy2 = q2.y - q1.y;
  const denom = dx1 * dy2 - dy1 * dx2;
  if (denom === 0) return undefined;
  const t = ((q1.x - p1.x) * dy2 - (q1.y - p1.y) * dx2) / denom;
  const u = ((q1.x - p1.x) * dy1 - (q1.y - p1.y) * dx1) / denom;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return undefined;
  return { x: p1.x + t * dx1, y: p1.y + t * dy1 };
}

/**
 * Ensure internal section is both contained and clipped to the parent faction loop.
 */
export function clipSectionToLoop(
  section: BorderSection,
  parentLoop: Array<VoronoiBorderNode>,
): { keep: boolean; section: BorderSection } {
  if (!section.edges || section.edges.length === 0) {
    return { keep: false, section };
  }

  const samples = samplePointsFromSection(section);
  if (samples.length === 0) {
    return { keep: false, section };
  }

  const insideSamples = samples.filter((s) =>
    pointInPolygon(s.x, s.y, parentLoop.map((v) => ({ x: v.x, y: v.y })))
  );

  if (insideSamples.length === 0) {
    // Entirely outside parent loop -> drop
    return { keep: false, section };
  }

  if (insideSamples.length === samples.length) {
    // Fully contained -> keep as-is
    return { keep: true, section };
  }

  // Partially outside -> clip
  clipSectionEdgesToLoop(section, parentLoop);

  return {
    keep: section.edges.length > 0,
    section,
  };
}
