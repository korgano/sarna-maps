import { BorderEdgeLoop } from '../types';
import { logger, signedAreaOfPolygon } from '../../../common';
import { reverseEdgeLoop } from './utils';

/**
 * Ensures that the given loop has its linked list of edges ordered in a clockwise fashion.
 * Once a loop is guaranteed to be clockwise, its inner affiliation can be determined by looking
 * at any edge's right side vertex.
 *
 * Uses the Shoelace signed area formula to robustly determine winding direction.
 * This replaces the previous cross-product test which relied on minEdgeIdx being
 * on the convex hull — a condition that broke after simplify passes moved nodes.
 *
 * Frame convention (critical): loops live in MAP coordinates, where Y increases
 * UPWARD (render negates y for SVG screen output). `signedAreaOfPolygon`
 * implements a negated shoelace, so in map coordinates:
 *   - signedArea > 0 → clockwise (CW) → correct, no reversal needed
 *   - signedArea < 0 → counter-clockwise (CCW) → reverse to make CW
 * A previous revision reasoned in screen coordinates here and reversed exactly
 * the wrong way, leaving every loop CCW: interiors sat on the LEFT, owner
 * computation returned outsiders, enclave dedup stopped removing nested
 * duplicates (doubled strokes/fills on all borders), and separation pulled
 * borders away from their own systems instead of toward them.
 *
 * Uses the most common rightAffiliation across all edges rather than just the first edge,
 * to avoid incorrect innerAffiliation when the fallback assignment (both vertices on same side)
 * is used for some edges.
 *
 * Modifies the provided edge loop in-place.
 *
 * @param edgeLoop
 */
export function ensureEdgeLoopClockwiseOrder(edgeLoop: BorderEdgeLoop) {
  const points = edgeLoop.edges.map((edge) => edge.node1);
  const signedArea = signedAreaOfPolygon(points);

  if (signedArea === 0) {
    logger.debug(
      'ensure-edge-loop-clockwise-order.ts',
      'Degenerate loop (zero signed area), skipping orientation correction',
      edgeLoop.innerAffiliation,
    );
  } else if (signedArea < 0) {
    // In map coords (Y-up), negative signed area = CCW → reverse to make CW
    reverseEdgeLoop(edgeLoop);
  }
  // signedArea > 0: already CW in map coords, no change needed

  // set loop object's inner affiliation information using the most common
  // rightAffiliation across all edges, rather than just edges[0], to avoid
  // incorrect innerAffiliation when some edges use the fallback assignment
  // (both vertices on same side) which may assign the wrong rightAffiliation.
  const rightCounts = new Map<string, number>();
  for (const edge of edgeLoop.edges) {
    const aff = edge.rightAffiliation;
    if (aff) {
      rightCounts.set(aff, (rightCounts.get(aff) ?? 0) + 1);
    }
  }
  let bestAff = edgeLoop.edges[0].rightAffiliation;
  let bestCount = 0;
  for (const [aff, count] of rightCounts) {
    if (count > bestCount) {
      bestAff = aff;
      bestCount = count;
    }
  }
  edgeLoop.innerAffiliation = bestAff || edgeLoop.edges[0].rightAffiliation;
  edgeLoop.outerAffiliation = edgeLoop.edges[0].leftAffiliation;
}
