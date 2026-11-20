/**
 * Applies a moving-average smoothing to Voronoi border edge nodes.
 *
 * Node-based: each unique node in a section is smoothed exactly once per pass
 * from its ordered neighbors along the section, then the result is written
 * back to every edge endpoint referencing that node. The previous
 * implementation smoothed edge.node1/node2 independently, which split shared
 * nodes between consecutive edges (and between factions) and produced
 * cracks, self-intersections, and non-containment.
 *
 * Three-way junctions (nodes with >2 border affiliations) and disputed-zone
 * edges are left untouched so T-junctions and disputed boundaries stay pinned.
 *
 * NOTE: no render path currently calls this — control points are generated on
 * the separated geometry in calculateVoronoiBorders and both render passes
 * consume identical geometry. Keep it that way; re-enabling a render-time
 * pass without the neutral layer diverges clip/fill geometry.
 *
 * @param sections Array of BorderSection objects to smooth (new array returned, edges cloned)
 * @param passes Number of smoothing passes to apply (default: 3)
 * @returns New BorderSection objects with smoothed node positions
 */
import { BorderSection } from '../types';
import { isDisputedZoneEdge } from '../../../common/utils/disputed-affiliation';

function isDisputedSection(section: BorderSection): boolean {
  return section.edges.some((e) => isDisputedZoneEdge(e));
}

export function smoothBorderSections(sections: Array<BorderSection>, passes = 3): Array<BorderSection> {
  // Clone edges so callers' loops are never mutated in place.
  let result = sections.map((section) => ({
    ...section,
    edges: section.edges.map((edge) => ({
      ...edge,
      node1: { ...edge.node1 },
      node2: { ...edge.node2 },
    })),
  }));

  for (let pass = 0; pass < passes; pass++) {
    result = result.map((section) => {
      if (section.edges.length === 0) return section;
      if (isDisputedSection(section)) return section;

      // Ordered node list along the section: [e0.n1, e0.n2, e1.n2, ...].
      // Consecutive edges share nodes by construction (e[i].node2 === e[i+1].node1
      // positionally), so smoothing this list once preserves identity.
      const nodes = [section.edges[0].node1, ...section.edges.map((e) => e.node2)];
      const closed =
        section.isLoop ||
        (nodes.length > 1 &&
          nodes[0].id !== undefined &&
          nodes[nodes.length - 1].id !== undefined &&
          (nodes[0] as { id: string }).id === (nodes[nodes.length - 1] as { id: string }).id);

      const smoothed = nodes.map((node, i) => {
        // Pin three-way junctions.
        const affCount = Object.keys((node as { borderAffiliations?: Record<string, boolean> }).borderAffiliations ?? {}).length;
        if (affCount > 2) return { x: node.x, y: node.y };
        let prev = nodes[i - 1];
        let next = nodes[i + 1];
        if (closed) {
          // Wrap around the loop, skipping the duplicated closing node.
          const ring = nodes.slice(0, nodes.length - 1);
          prev = ring[(i - 1 + ring.length) % ring.length] ?? node;
          next = ring[(i + 1) % ring.length] ?? node;
          if (i === nodes.length - 1) return { x: smoothedFor(prev, node, next).x, y: smoothedFor(prev, node, next).y };
        } else {
          prev = prev ?? node;
          next = next ?? node;
        }
        return smoothedFor(prev, node, next);
      });

      // Write back: edge[i].node1 = smoothed[i], edge[i].node2 = smoothed[i+1].
      // For closed loops the duplicated closing node gets the same value as index 0.
      const newEdges = section.edges.map((edge, i) => ({
        ...edge,
        node1: { ...edge.node1, x: smoothed[i].x, y: smoothed[i].y },
        node2: { ...edge.node2, x: smoothed[i + 1].x, y: smoothed[i + 1].y },
      }));
      if (closed && newEdges.length > 0) {
        const first = newEdges[0].node1;
        const lastEdge = newEdges[newEdges.length - 1];
        lastEdge.node2 = { ...lastEdge.node2, x: first.x, y: first.y };
      }
      return { ...section, edges: newEdges };
    });
  }

  return result;
}

function smoothedFor(
  prev: { x: number; y: number },
  node: { x: number; y: number },
  next: { x: number; y: number },
): { x: number; y: number } {
  // Weighted average: 0.3 * prev + 0.4 * current + 0.3 * next.
  return {
    x: 0.3 * prev.x + 0.4 * node.x + 0.3 * next.x,
    y: 0.3 * prev.y + 0.4 * node.y + 0.3 * next.y,
  };
}
