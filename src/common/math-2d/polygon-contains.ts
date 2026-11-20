import { Point2d } from './types';

/**
 * Ray-casting point-in-polygon test. The polygon is defined by an ordered
 * array of vertices. Works for either winding order and handles convex and
 * concave polygons.
 *
 * @param polygon Ordered polygon vertices (does not need to be explicitly closed)
 * @param point The point to test
 * @returns true if the point is inside the polygon
 */
export function polygonContains(polygon: Array<Point2d>, point: Point2d): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersects =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}
