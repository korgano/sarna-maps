import { BorderSection, VoronoiBorderNode, VoronoiBorderEdge } from '../types';
import { distance, pointsAreClose } from '../../../common';

const SNAP_RADIUS = 2.0;
const INTERNAL_BRIDGE_THRESHOLD = 0.5;
const MIN_ANGLE_COS = 0.6;

function getLoopNodes(
  parentLoops: Record<string, Array<BorderSection>>,
  parentAffiliation: string,
): Array<VoronoiBorderNode> {
  const loops = parentLoops[parentAffiliation];
  if (!loops || loops.length === 0) return [];
  const nodes: Array<VoronoiBorderNode> = [];
  loops[0].edges.forEach((e) => {
    nodes.push(e.node1);
    nodes.push(e.node2);
  });
  return nodes;
}

function cosineSimilarity(
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const magA = Math.sqrt(ax * ax + ay * ay);
  const magB = Math.sqrt(bx * bx + by * by);
  if (magA === 0 || magB === 0) return -1;
  return (ax * bx + ay * by) / (magA * magB);
}

export function connectInternalBorderSections(
  levelIndex: number,
  internalSections: Array<BorderSection>,
  parentLoops: Array<Record<string, Array<BorderSection>>>,
) {
  // Pass 1: snap endpoints to parent loops (tolerance + direction + containment)
  internalSections.forEach((section) => {
    if (!section.edges || section.edges.length === 0) return;

    const parentAffTokens = section.affiliation1.split(',').slice(0, levelIndex);
    let node1Changed = false;
    let node2Changed = false;

    for (let parentLevel = 0; parentLevel < levelIndex; parentLevel++) {
      const parentAff = parentAffTokens.slice(0, parentLevel + 1).join(',');
      const outsideAff1 = Object.keys(section.node1.borderAffiliations || {})
        .find((aff) => !aff.startsWith(parentAff));
      const outsideAff2 = Object.keys(section.node2.borderAffiliations || {})
        .find((aff) => !aff.startsWith(parentAff));

      const loopNodes = getLoopNodes(parentLoops[parentLevel] || {}, parentAff);
      if (!loopNodes.length) continue;

      const bestStart = findBestSnapNode(
        loopNodes,
        section,
        section.node1,
        'start',
        parentAff,
      );
      const bestEnd = findBestSnapNode(
        loopNodes,
        section,
        section.node2,
        'end',
        parentAff,
      );

      if (!node1Changed && outsideAff1 && bestStart) {
        const n = bestStart;
        section.edges[0].node1.x = n.x;
        section.edges[0].node1.y = n.y;
        section.node1.x = n.x;
        section.node1.y = n.y;
        node1Changed = true;
      }

      if (!node2Changed && outsideAff2 && bestEnd) {
        const n = bestEnd;
        const lastEdge = section.edges[section.edges.length - 1];
        lastEdge.node2.x = n.x;
        lastEdge.node2.y = n.y;
        section.node2.x = n.x;
        section.node2.y = n.y;
        node2Changed = true;
      }

      if (node1Changed && node2Changed) {
        break;
      }
    }
  });

  // Pass 2: bridge small gaps between internal sections
  bridgeInternalSections(internalSections);
}

function findBestSnapNode(
  loopNodes: Array<VoronoiBorderNode>,
  section: BorderSection,
  targetNode: VoronoiBorderNode,
  side: 'start' | 'end',
  parentAffiliation: string,
): VoronoiBorderNode | undefined {
  const candidates = loopNodes.filter((n) => {
    const d = distance(n, targetNode);
    return d <= SNAP_RADIUS;
  });

  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  // Prefer candidates aligned with the section edge direction.
  // Use first/last edge direction depending on side.
  const edge = side === 'start'
    ? section.edges[0]
    : section.edges[section.edges.length - 1];

  if (!edge || !edge.node1 || !edge.node2) {
    return candidates.reduce((best, n) =>
      distance(n, targetNode) < distance(best, targetNode) ? n : best
    );
  }

  const dxSec = edge.node2.x - edge.node1.x;
  const dySec = edge.node2.y - edge.node1.y;

  let best = candidates[0];
  let bestScore = -Infinity;

  for (const n of candidates) {
    const d = distance(n, targetNode);
    const dxCand = n.x - targetNode.x;
    const dyCand = n.y - targetNode.y;
    const cos = cosineSimilarity(dxSec, dySec, dxCand, dyCand);

    // Combine proximity and alignment: prioritize proximity but reward alignment.
    const score = (cos >= MIN_ANGLE_COS ? 1 : 0) - d * 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = n;
    }
  }

  return best;
}

/**
 * Bridge small gaps: if one section's node2 is near another's node1,
 * align them to avoid dangling borders.
 */
function bridgeInternalSections(
  sections: Array<BorderSection>,
) {
  // Only attempt a limited number of iterations.
  for (let iter = 0; iter < 2; iter++) {
    let changed = false;
    for (let i = 0; i < sections.length; i++) {
      for (let j = 0; j < sections.length; j++) {
        if (i === j) continue;
        const a = sections[i];
        const b = sections[j];

        if (!a.node2 || !b.node1) continue;

        if (
          !pointsAreClose(a.node2, b.node1, INTERNAL_BRIDGE_THRESHOLD)
        ) {
          continue;
        }

        // Snap b.node1 to a.node2.
        b.node1.x = a.node2.x;
        b.node1.y = a.node2.y;
        if (b.edges && b.edges[0] && b.edges[0].node1) {
          b.edges[0].node1.x = a.node2.x;
          b.edges[0].node1.y = a.node2.y;
        }

        changed = true;
      }
    }
    if (!changed) break;
  }
}
