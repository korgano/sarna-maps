import { VoronoiBorderEdge, BorderSection, VoronoiBorderNode, BorderDelaunayVertex } from '../types';
import { DelaunayVertex, distance, nearestPointOnLineSegment, Point2d, pointOnLine, extractBorderStateAffiliation } from '../../../common';
import { SalientPoint } from '../../types';
import { EMPTY_FACTION, INDEPENDENT } from '../../constants';

// TODO put these values in a config file
// The distance of the merge points along a salient path
const MERGE_POINT_STEP = 2;
// The maximum distance between two same-faction islands for a salient tunnel.
// CFG's Diosd (-2.34, 230.53) and Karbala (-23.78, 196.67) are ~40 map units apart —
// beyond this threshold — so they are NOT connected into one region. This lets
// Lothan (DC, at -9.84, 220.71) sit between them with its own DC region rather
// than being squeezed by an overextended CFG region.
const MAX_DISTANCE = 20.0;
// Radius (map units) within which a foreign-faction system blocks a salient
// tunnel. A salient passing within this distance of a foreign system is rejected
// — the corridor must stay in same-faction territory, not cut through a rival's
// space.
const FOREIGN_COLLISION_RADIUS = 5.5;

/**
 * A salient as understood here is a thin stretch of territory ranging into
 * another territory, connecting the faction's main area to relatively close
 * "islands" also belonging to that faction.
 *
 * Since we are trying to do this as early as possible in the overall border
 * generation process, we'll have to work with simple border loops here, comparing
 * their affiliations and finding close nodes.
 *
 * The general idea of the algorithm is as follows:
 * - Consider the different loops / "islands" for a given faction
 * - Attempt to find a close (<= MAX_DISTANCE map units) loop for that same faction
 * - To connect the two sections, draw a "tunnel" of merge points and ensure it
 *   does not pass within FOREIGN_COLLISION_RADIUS of any foreign-faction system
 * - Distant same-faction islands (e.g. CFG Diosd vs CFG Karbala at ~40 mu) are
 *   deliberately left unconnected so each keeps its own region
 */
export function connectSalients(loops: Record<string, Array<BorderSection>>, vertices: Array<BorderDelaunayVertex>) {
  const mergePoints: Array<SalientPoint> = [];

  for (let faction in loops) {
    // run the salient logic for each loop that is not the largest for that faction
    for (let i = 1; i < loops[faction].length; i++) {
      if (loops[faction][i].innerAffiliation !== EMPTY_FACTION && loops[faction][i].innerAffiliation !== faction) {
        // skip any islands for different factions - they will be handled by that faction's logic
        continue;
      }
      const closestEdges = findCloseSectionEdges(loops[faction][i], loops[faction], vertices, faction);
      if (closestEdges.length > 0) {
        // find the full affiliation for the salient
        const fullAffiliation = [
          vertices[closestEdges[0].closestIslandNode.vertex1Idx].affiliation,
          vertices[closestEdges[0].closestIslandNode.vertex2Idx].affiliation,
          vertices[closestEdges[0].closestIslandNode.vertex3Idx].affiliation,
        ].find((affiliation) => (affiliation === faction) || (affiliation || '').split('|')[0] === faction);
        // generate merge points for the salient
        const salientDistance = distance(closestEdges[0].closestIslandNode, closestEdges[0].closestSectionPoint);
        if (salientDistance < MERGE_POINT_STEP) {
          mergePoints.push({
            id: `salient-merge-point-${faction}-${i}-0-min`,
            affiliation: fullAffiliation || faction,
            info: `closest edge 0 from loop ${i} with faction ${faction} and fullAffiliation ${fullAffiliation}`,
            ...pointOnLine(closestEdges[0].closestIslandNode, closestEdges[0].closestSectionPoint, salientDistance * 0.5),
          });
        }
        for (let mergePointDistance = MERGE_POINT_STEP; mergePointDistance < salientDistance; mergePointDistance += MERGE_POINT_STEP) {
          mergePoints.push({
            id: `salient-merge-point-${faction}-${i}-0-${mergePointDistance}`,
            affiliation: fullAffiliation || faction,
            info: `closest edge 0 from loop ${i} with faction ${faction} and fullAffiliation ${fullAffiliation}`,
            ...pointOnLine(closestEdges[0].closestIslandNode, closestEdges[0].closestSectionPoint, mergePointDistance),
          });
        }
      }
    }
  }
  return mergePoints;
}

function findCloseSectionEdges(
  island: BorderSection,
  sections: Array<BorderSection>,
  vertices: Array<BorderDelaunayVertex>,
  faction: string,
) {
  const closestEdges: Array<{
    section: BorderSection;
    edge: VoronoiBorderEdge;
    distToIsland: number;
    closestIslandNode: VoronoiBorderNode;
    closestSectionPoint: Point2d;
    collisionCandidates: Array<number>;
  }> = [];
  const islandNodes = island.edges.map((edge) => edge.node1);
  for (const section of sections) {
    // the looked at section is not interesting to us if it's the island itself
    if (section.id === island.id) {
      continue;
    }

    // look at all the section's edges to find one that is close enough to the island
    for (const edge of section.edges) {
      let distToIsland = Infinity;
      let closestIslandNode: VoronoiBorderNode = island.edges[0].node1;
      let closestSectionPoint: Point2d | null = null;
      for (const islandNode of islandNodes) {
        const nearestPointOnEdge = nearestPointOnLineSegment(edge.node1, edge.node2, islandNode, true);
        if (!nearestPointOnEdge) continue;
        const dist = distance(nearestPointOnEdge, islandNode);
        if (dist < distToIsland) {
          distToIsland = dist;
          closestIslandNode = islandNode;
          closestSectionPoint = nearestPointOnEdge;
        }
      }
      // Only consider edges within MAX_DISTANCE. Distant same-faction islands
      // (e.g. CFG Diosd vs CFG Karbala at ~40 mu) are not connected, so each
      // keeps its own region instead of merging into an overextended territory.
      if (distToIsland > MAX_DISTANCE || !closestSectionPoint) {
        continue;
      }
      // Reject corridors that pass within FOREIGN_COLLISION_RADIUS of a
      // foreign-faction system. This keeps salient tunnels inside same-faction
      // territory and prevents them from cutting through a rival's space
      // (e.g. a CFG tunnel must not pass through DC's Lothan).
      const corridorMid = {
        x: (closestIslandNode.x + closestSectionPoint.x) / 2,
        y: (closestIslandNode.y + closestSectionPoint.y) / 2,
      };
      let collidesWithForeign = false;
      for (const v of vertices) {
        const vAff = extractBorderStateAffiliation(v.affiliation, undefined, undefined, 1, true);
        if (!vAff || vAff === EMPTY_FACTION || vAff === INDEPENDENT) continue;
        if (vAff.toUpperCase() === faction.toUpperCase()) continue;
        const distToCorridor = Math.hypot(v.x - corridorMid.x, v.y - corridorMid.y);
        if (distToCorridor < FOREIGN_COLLISION_RADIUS) {
          collidesWithForeign = true;
          break;
        }
      }
      if (collidesWithForeign) {
        continue;
      }
      closestEdges.push({
        section,
        edge,
        distToIsland,
        closestIslandNode,
        closestSectionPoint,
        collisionCandidates: [
          edge.node1.vertex1Idx,
          edge.node1.vertex2Idx,
          edge.node1.vertex3Idx,
          edge.node2.vertex1Idx,
          edge.node2.vertex2Idx,
          edge.node2.vertex3Idx,
          closestIslandNode.vertex1Idx,
          closestIslandNode.vertex2Idx,
          closestIslandNode.vertex3Idx,
        ].sort((a, b) => a - b)
          .filter((element, i, arr) => i === 0 || element !== arr[i - 1]),
      });
    }
  }

  closestEdges.sort((a, b) => a.distToIsland - b.distToIsland);
  return closestEdges.slice(0, 3);
}
