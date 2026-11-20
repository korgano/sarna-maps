import { Point2d } from './types';

/**
 * Compute the signed area of a polygon using a negated-Shoelace formula
 * (this returns the NEGATIVE of the standard shoelace sum).
 *
 * Sign convention depends on the Y-axis direction of the INPUT coordinates:
 *   - Y increases upward (map coordinates): positive → clockwise (CW),
 *     negative → counter-clockwise (CCW)
 *   - Y increases downward (screen coordinates): signs flip — positive → CCW,
 *     negative → CW
 *
 * Do NOT assume a frame here; see `ensureEdgeLoopClockwiseOrder` for the
 * map-frame convention. A previous revision documented screen coordinates
 * while being called with map coordinates, which inverted every border loop.
 *
 * @param points Ordered polygon vertices (does not need to be explicitly closed — the
 *   last edge from points[n-1] back to points[0] is implicit).
 * @returns Signed area (zero → degenerate polygon)
 */
export function signedAreaOfPolygon(points: Array<Point2d>): number {
  if (points.length < 3) return 0;
  let area = 0;
  let j = points.length - 1;
  for (let i = 0; i < points.length; i++) {
    area += (points[j].x + points[i].x) * (points[j].y - points[i].y);
    j = i;
  }
  return area * 0.5;
}
