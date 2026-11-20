import { VoronoiBorderEdge, BorderSection } from '../types';
import { deepCopy, logger, pointsAreClose, Point2d } from '../../../common';
import { reverseEdges } from './utils';

const MERGE_EPSILON = 0.5;

function snapPoint(a: Point2d, b: Point2d) {
  a.x = b.x;
  a.y = b.y;
}

function tryMergeSections(
  s1: BorderSection,
  s2: BorderSection,
): boolean {
  if (pointsAreClose(s1.node1, s2.node1, MERGE_EPSILON)) {
    snapPoint(s2.node1, s1.node1);
    s1.edges.unshift(...reverseEdges(s2.edges));
    return true;
  }
  if (pointsAreClose(s1.node1, s2.node2, MERGE_EPSILON)) {
    snapPoint(s2.node2, s1.node1);
    s1.edges.unshift(...s2.edges);
    return true;
  }
  if (pointsAreClose(s1.node2, s2.node1, MERGE_EPSILON)) {
    snapPoint(s2.node1, s1.node2);
    s1.edges.push(...s2.edges);
    return true;
  }
  if (pointsAreClose(s1.node2, s2.node2, MERGE_EPSILON)) {
    snapPoint(s2.node2, s1.node2);
    s1.edges.push(...reverseEdges(s2.edges));
    return true;
  }
  return false;
}

export function generateBorderSections(borderEdges: Record<string, Array<VoronoiBorderEdge>>) {
  const borderSections: Array<BorderSection> = [];

  Object.keys(borderEdges).forEach((combinedAffiliations) => {
    const originalEdges = borderEdges[combinedAffiliations];
    const [affiliation1, affiliation2] = combinedAffiliations.split('___').sort();

    const sections = deepCopy(originalEdges).map((edge, edgeIndex) => ({
      id: `section_${edgeIndex + 1}`,
      edges: [edge],
      isLoop: false,
      affiliation1,
      affiliation2,
      node1: edge.node1,
      node2: edge.node2,
      length: -1,
      minEdgeIdx: -1,
    } as BorderSection));

    const ITERATIONS_LIMIT = 10000;
    for (let iterations = 0; iterations < ITERATIONS_LIMIT; iterations++) {
      let changeMade = false;
      for (let i = 0; i < sections.length; i++) {
        for (let j = i + 1; j < sections.length; j++) {
          if (tryMergeSections(sections[i], sections[j])) {
            sections[i].node1 = sections[i].edges[0].node1;
            sections[i].node2 = sections[i].edges[sections[i].edges.length - 1].node2;
            sections[i].isLoop = pointsAreClose(sections[i].node1, sections[i].node2, MERGE_EPSILON);
            sections.splice(j, 1);
            j--;
            changeMade = true;
          }
        }
      }
      if (!changeMade) {
        break;
      }
      if (iterations === ITERATIONS_LIMIT - 1) {
        logger.warn(`Iterations limit reached while generating border sections for "${combinedAffiliations}". Aborting.`);
      }
    }
    borderSections.push(...sections);
  });
  return borderSections;
}
