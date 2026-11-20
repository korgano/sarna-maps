import { BorderEdgeLoop, BorderSection } from '../../../compute';

function isValidPoint(p: { x: number; y: number }): boolean {
  return p != null && isFinite(p.x) && isFinite(p.y);
}

/**
 * Returns true when three consecutive points lie on a straight line
 * (within a small tolerance). The middle point is redundant and can be
 * removed without changing the visible geometry.
 *
 * Tolerance: cross-product magnitude <= 0.001 map units^2. Points within
 * ~0.03 mu of the chord are considered collinear — small enough to be
 * invisible at map scale, large enough to avoid dropping real corners.
 */
function areCollinear(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }): boolean {
  const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return Math.abs(cross) <= 0.001;
}

/**
 * Removes intermediate points that lie on a straight line between their
 * neighbors. Preserves the first and last points, and all curve control
 * points (curves are emitted as-is; only straight segments are simplified).
 *
 * @param points The ordered list of path points (one per edge endpoint)
 * @returns Indices of points to keep (first and last always included)
 */
function collinearKeepIndices(points: Array<{ x: number; y: number }>): Array<number> {
  if (points.length <= 2) return points.map((_, i) => i);
  const keep: Array<number> = [0];
  for (let i = 1; i < points.length - 1; i++) {
    if (!areCollinear(points[i - 1], points[i], points[i + 1])) {
      keep.push(i);
    }
  }
  keep.push(points.length - 1);
  return keep;
}

export function generateSectionPath(section: BorderSection | BorderEdgeLoop, renderCurves: boolean) {
  let d = '';
  if (!section.edges || section.edges.length === 0) {
    return d;
  }
  // Closed-loop detection: BorderSection carries isLoop; BorderEdgeLoop does
  // not, so fall back to geometric closure (id match, then coordinate match).
  // Closed contours MUST end with Z — without it, evenodd fill spans the
  // implicit close chord and produces giant blob triangles.
  const first = section.edges[0].node1;
  const last = section.edges[section.edges.length - 1].node2;
  const declaredLoop = 'isLoop' in section ? (section as BorderSection).isLoop : undefined;
  const geometricallyClosed =
    (first as { id?: string }).id !== undefined &&
    (last as { id?: string }).id !== undefined
      ? (first as { id: string }).id === (last as { id: string }).id
      : Math.abs(first.x - last.x) <= 0.000001 && Math.abs(first.y - last.y) <= 0.000001;
  const isClosed = declaredLoop !== undefined ? (declaredLoop || geometricallyClosed) : geometricallyClosed;

  // Collect every edge endpoint in order: node1 of edge 0, then node2 of each edge.
  // These are the candidate path vertices. Collinear intermediates are dropped
  // below so a straight border edge emits just "M x1,y1 L x2,y2" instead of
  // "M x1,y1 L xi,yi L x2,y2" with an unnecessary point on the segment.
  const endpoints: Array<{ x: number; y: number }> = [];
  endpoints.push({ x: first.x, y: first.y });
  for (const edge of section.edges) {
    endpoints.push({ x: edge.node2.x, y: edge.node2.y });
  }

  // For straight-line rendering, drop collinear points to use the minimum
  // necessary nodes. Curves are emitted as-is (control points define shape;
  // removing a node would change the curve).
  const keepIndices = renderCurves
    ? endpoints.map((_, i) => i)
    : collinearKeepIndices(endpoints);

  for (let edgeIndex = 0; edgeIndex < section.edges.length; edgeIndex++) {
    const edge = section.edges[edgeIndex];
    // endIdx is the index of edge.node2 in the endpoints array
    const endIdx = edgeIndex + 1;

    // Emit the move-to for the first kept point (edge 0's node1).
    if (edgeIndex === 0 && keepIndices.includes(0)) {
      d += ` M${endpoints[0].x.toFixed(2)},${(-endpoints[0].y).toFixed(2)}`;
    }

    // For straight-line rendering, emit L only to kept endpoints. Dropped
    // (collinear) points are skipped — the next kept endpoint's L draws a
    // straight line across them from the last emitted point.
    if (!renderCurves || (!edge.n1c2 && !edge.n2c1)) {
      if (keepIndices.includes(endIdx)) {
        d += ` L${edge.node2.x.toFixed(2)},${(-edge.node2.y).toFixed(2)}`;
      }
    } else if (edge.n1c2 && !edge.n2c1 && isValidPoint(edge.n1c2)) {
      d += ` Q${edge.n1c2.x.toFixed(2)},${(-edge.n1c2.y).toFixed(2)}`
      d += ` ${edge.node2.x.toFixed(2)},${(-edge.node2.y).toFixed(2)}`;
    } else if (!edge.n1c2 && edge.n2c1 && isValidPoint(edge.n2c1)) {
      d += ` Q${edge.n2c1.x.toFixed(2)},${(-edge.n2c1.y).toFixed(2)}`
      d += ` ${edge.node2.x.toFixed(2)},${(-edge.node2.y).toFixed(2)}`;
    } else if (edge.n1c2 && edge.n2c1 && isValidPoint(edge.n1c2) && isValidPoint(edge.n2c1)) {
      d += ` C${edge.n1c2.x.toFixed(2)},${(-edge.n1c2.y).toFixed(2)}`;
      d += ` ${edge.n2c1.x.toFixed(2)},${(-edge.n2c1.y).toFixed(2)}`;
      d += ` ${edge.node2.x.toFixed(2)},${(-edge.node2.y).toFixed(2)}`;
    } else {
      // Fallback: straight line when control points are invalid
      d += ` L${edge.node2.x.toFixed(2)},${(-edge.node2.y).toFixed(2)}`;
    }
  }
  if (isClosed) {
    d += ' Z';
  }
  return d;
}
