import { BezierEdge2d, Point2d, Point2dWithEdgeContext } from './types';
import { pointOnCubicBezierCurve } from './point-on-cubic-bezier-curve';
import { pointOnLine } from './point-on-line';
import { pointOnQuadraticBezierCurve } from './point-on-quadratic-bezier-curve';
import { distance } from './distance';
import { normalizeVector } from './normalize-vector';
import { dotProduct } from './dot-product';

/**
 * Get the point on the given edge path (ordered sequence of edges) that lies at the provided distance, where the first
 * edge's first edge point is at distance 0.
 * Note that the function does not wrap around, i.e. it only returns a point if dist <= edge path length.
 *
 * @param edgePath The ordered edge sequence
 * @param dist The distance at which to look for a point on the edge path
 * @param includeEdgeInfo set to true to include context information, specifically the point's distance to the next edge point and the angle of the adjacent edges
 * @param prefixSum Optional precomputed cumulative edge lengths array (same length as edgePath + 1).
 *   When provided, uses binary search for O(log n) edge lookup instead of O(n) linear scan.
 *   Build with: `buildEdgePathPrefixSum(edgePath)`
 */
export function pointAlongEdgePath(
  edgePath: Array<BezierEdge2d>,
  dist: number,
  includeEdgeInfo = false,
  prefixSum?: Array<number>,
): Point2dWithEdgeContext | undefined {
  let edgeI: number;
  let remainingDistance: number;

  if (prefixSum) {
    // Binary search for the edge containing the target distance
    const totalLength = prefixSum[prefixSum.length - 1];
    if (dist >= totalLength) {
      return undefined;
    }
    let lo = 0;
    let hi = prefixSum.length - 2; // last valid edge index
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (prefixSum[mid + 1] <= dist) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    edgeI = lo;
    remainingDistance = dist - prefixSum[edgeI];
  } else {
    edgeI = 0;
    remainingDistance = dist;
    let found = false;
    for (let i = 0; i < edgePath.length; i++) {
      const currentEdge = edgePath[i];
      if ((currentEdge.length || 0) < remainingDistance) {
        remainingDistance -= currentEdge.length || 0;
      } else {
        edgeI = i;
        found = true;
        break;
      }
    }
    if (!found) {
      return undefined;
    }
  }

  const currentEdge = edgePath[edgeI];

  let pointOnEdge: Point2d;
  if (currentEdge.p1c2 !== undefined && currentEdge.p2c1 !== undefined) {
    pointOnEdge = pointOnCubicBezierCurve(
      currentEdge.p1,
      (currentEdge.p1c2 || currentEdge.p2c1) as Point2d,
      (currentEdge.p2c1 || currentEdge.p1c2) as Point2d,
      currentEdge.p2,
      remainingDistance / (currentEdge.length || 1),
    );
  } else if (currentEdge.p1c2 !== undefined || currentEdge.p2c1 !== undefined) {
    pointOnEdge = pointOnQuadraticBezierCurve(
      currentEdge.p1,
      (currentEdge.p1c2 || currentEdge.p2c1) as Point2d,
      currentEdge.p2,
      remainingDistance / (currentEdge.length || 1),
    );
  } else {
    pointOnEdge = pointOnLine(currentEdge.p1, currentEdge.p2, remainingDistance);
  }

  if (includeEdgeInfo) {
    const p1Distance = distance(currentEdge.p1, pointOnEdge);
    const p2Distance = distance(currentEdge.p2, pointOnEdge);
    let adjacentEdgesDotProduct = 0;
    let distanceToClosestPoint = 0;
    let edgePoints: [Point2d, Point2d, Point2d];
    if (p1Distance <= p2Distance) {
      distanceToClosestPoint = p1Distance;
      const previousEdge = edgePath[(edgeI - 1 + edgePath.length) % edgePath.length];
      edgePoints = [previousEdge.p1, currentEdge.p1, currentEdge.p2];
    } else {
      distanceToClosestPoint = p2Distance;
      const nextEdge = edgePath[(edgeI + 1) % edgePath.length];
      edgePoints = [currentEdge.p1, currentEdge.p2, nextEdge.p2];
    }
    const vec1 = { a: edgePoints[0].x - edgePoints[1].x, b: edgePoints[0].y - edgePoints[1].y };
    const vec2 = { a: edgePoints[2].x - edgePoints[1].x, b: edgePoints[2].y - edgePoints[1].y };
    normalizeVector(vec1);
    normalizeVector(vec2);
    adjacentEdgesDotProduct = dotProduct(vec1, vec2);
    return {
      point: pointOnEdge,
      adjacentEdgesDotProduct,
      distanceToClosestPoint,
    };
  }
  return { point: pointOnEdge };
}

/**
 * Build a prefix sum array of cumulative edge lengths for use with pointAlongEdgePath.
 * The resulting array has length edgePath.length + 1, where prefixSum[0] = 0 and
 * prefixSum[i] = total length of edges 0..i-1.
 *
 * @param edgePath The ordered edge sequence
 * @returns Array of cumulative edge lengths
 */
export function buildEdgePathPrefixSum(edgePath: Array<BezierEdge2d>): Array<number> {
  const prefixSum = new Array<number>(edgePath.length + 1);
  prefixSum[0] = 0;
  for (let i = 0; i < edgePath.length; i++) {
    prefixSum[i + 1] = prefixSum[i] + (edgePath[i].length || 0);
  }
  return prefixSum;
}
