import { BorderEdgeLoop } from '../../types';
import { swapEdgeNodes } from './swap-edge-nodes';

/**
 * Reverses a given border edge loop in-place. This means the passed object will be modified.
 *
 * @param edgeLoop The loop to reverse
 */
export function reverseEdgeLoop(edgeLoop: BorderEdgeLoop) {
  edgeLoop.edges.reverse();
  for (let edgeIdx = 0; edgeIdx < edgeLoop.edges.length; edgeIdx++) {
    swapEdgeNodes(edgeLoop.edges[edgeIdx]);
    const curMinX = edgeLoop.edges[edgeLoop.minEdgeIdx].node2.x;
    const curMinY = edgeLoop.edges[edgeLoop.minEdgeIdx].node2.y;
    const curX = edgeLoop.edges[edgeIdx].node2.x;
    const curY = edgeLoop.edges[edgeIdx].node2.y;
    if (
      curX < curMinX ||
      (curX === curMinX && curY < curMinY)
    ) {
      edgeLoop.minEdgeIdx = edgeIdx;
    }
  }
}
