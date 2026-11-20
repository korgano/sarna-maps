import { BorderLabelCandidate } from '../types';
import { distance, lineSegmentIntersection, Point2d, pointAlongEdgePath, pointIsLeftOfLine } from '../../../common';
import { BorderEdgeLoop } from '../../voronoi-border';

/**
 * Precompute the midpoint of each edge in a loop. Call once per loop, then pass
 * to calculateCandidateLoopOverlap for each candidate to avoid repeated allocation.
 *
 * @param loop The edge loop
 * @returns Array of midpoints, one per edge
 */
export function precomputeEdgeMidpoints(loop: BorderEdgeLoop): Array<Point2d | undefined> {
  return loop.edges.map((loopEdge) =>
    pointAlongEdgePath([{
      p1: loopEdge.node1,
      p2: loopEdge.node2,
      p1c2: loopEdge.n1c2,
      p2c1: loopEdge.n2c1,
      length: loopEdge.length,
    }], loopEdge.length * 0.5)?.point
  );
}

/**
 * Calculate a border label candidate's loopOverlapDistance field. The field is the approximate number of units
 * that the candidate intersects "past" its edge loop.
 *
 * @param candidate The border label candidate
 * @param loop The edge loop
 * @param earlyExitThreshold Optional: if provided, stop iterating once loopOverlapDistance exceeds this value
 *   (the candidate will be disqualified anyway)
 * @param precomputedMidpoints Optional: precomputed edge midpoints from precomputeEdgeMidpoints()
 */
export function calculateCandidateLoopOverlap(
  candidate: BorderLabelCandidate,
  loop: BorderEdgeLoop,
  earlyExitThreshold?: number,
  precomputedMidpoints?: Array<Point2d | undefined>,
) {
  candidate.loopOverlapDistance = 0;

  for (let i = 0; i < loop.edges.length; i++) {
    const loopEdge = loop.edges[i];
    const midPoint = precomputedMidpoints
      ? precomputedMidpoints[i]
      : pointAlongEdgePath([{
          p1: loopEdge.node1,
          p2: loopEdge.node2,
          p1c2: loopEdge.n1c2,
          p2c1: loopEdge.n2c1,
          length: loopEdge.length,
        }], loopEdge.length * 0.5)?.point;
    // For curves, check the two edges from the endpoints to the midpoint.
    // For straight edges, just use the two endpoints
    const intersectionDistance = midPoint
      ? Math.max(
          getIntersectionDistance(candidate, [loopEdge.node1, midPoint], !!loop.isInnerLoop),
          getIntersectionDistance(candidate, [midPoint, loopEdge.node2], !!loop.isInnerLoop),
        )
      : getIntersectionDistance(candidate, [loopEdge.node1, loopEdge.node2], !!loop.isInnerLoop);

    candidate.loopOverlapDistance = Math.max(candidate.loopOverlapDistance || 0, intersectionDistance);

    if (earlyExitThreshold !== undefined && candidate.loopOverlapDistance > earlyExitThreshold) {
      return;
    }
  }
}

/**
 * Calculate the intersection distance of a candidate and an edge defined by two points
 */
function getIntersectionDistance(
  candidate: BorderLabelCandidate,
  edgePoints: [Point2d, Point2d],
  isInnerLoop: boolean
) {

  // private helper function
  const getMaxIntersectionDistance = (
    points: [Point2d, Point2d],
    edgePoints: [Point2d, Point2d],
    intersectionPoint: Point2d,
  ) =>
    Math.max(
      ...points.filter(
        (point) => {
          const leftOfLine = pointIsLeftOfLine(point, edgePoints[0], edgePoints[1]);
          return (isInnerLoop && !leftOfLine) || (!isInnerLoop && leftOfLine);
        }
      ).map((point) => distance(point, intersectionPoint))
    );

  const baselineIntersectionPoint = lineSegmentIntersection(
    { p1: candidate.rect.bl, p2: candidate.rect.br },
    { p1: edgePoints[0], p2: edgePoints[1] },
  );
  const baselineIntersectionDistance = baselineIntersectionPoint
    ? getMaxIntersectionDistance([candidate.rect.bl, candidate.rect.br], edgePoints, baselineIntersectionPoint)
    : 0;
  const leftlineIntersectionPoint = lineSegmentIntersection(
    { p1: candidate.rect.bl, p2: candidate.rect.tl },
    { p1: edgePoints[0], p2: edgePoints[1] },
  );
  const leftlineIntersectionDistance = leftlineIntersectionPoint
    ? getMaxIntersectionDistance([candidate.rect.bl, candidate.rect.tl], edgePoints, leftlineIntersectionPoint)
    : 0;
  const toplineIntersectionPoint = lineSegmentIntersection(
    { p1: candidate.rect.tl, p2: candidate.rect.tr },
    { p1: edgePoints[0], p2: edgePoints[1] },
  );
  const toplineIntersectionDistance = toplineIntersectionPoint
    ? getMaxIntersectionDistance([candidate.rect.tl, candidate.rect.tr], edgePoints, toplineIntersectionPoint)
    : 0;
  const rightlineIntersectionPoint = lineSegmentIntersection(
    { p1: candidate.rect.tr, p2: candidate.rect.br },
    { p1: edgePoints[0], p2: edgePoints[1] },
  );
  const rightlineIntersectionDistance = rightlineIntersectionPoint
    ? getMaxIntersectionDistance([candidate.rect.tr, candidate.rect.br], edgePoints, rightlineIntersectionPoint)
    : 0;

  return Math.max(
    baselineIntersectionDistance,
    toplineIntersectionDistance,
    leftlineIntersectionDistance,
    rightlineIntersectionDistance,
  );
}
