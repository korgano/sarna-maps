import { dotProduct, normalizeVector, Point2d, generateBezierControlPoints } from '../../../common';
import { BorderEdgeLoop, VoronoiBorderEdge } from '../types';

const DEFAULT_TENSION = 0.3;
const DEFAULT_MIN_DOT = 0.75;

/**
 * Canonical, edge-centric bezier control points.
 *
 * Every handle is a pure function of (edgeId, nodeId) — the shared edge's
 * geometry — never of the faction loop a particular clone happens to belong to.
 *
 * Rule: at each node P of an edge P-Q, find the canonical continuation edge T
 * at P — the straightest adjacent edge other than P-Q, looked up globally via
 * the node->edge index (built from edgeMap; covers two-way chain nodes that
 * threeWayNodes does not index) with the same 0.75 dot-product threshold as the
 * previous findStraightestAdjacentEdge. The handle at P is then derived from the
 * triple (backward, P, forward) via generateBezierControlPoints:
 *
 *   * P === node1: triple (T, node1, node2)   -> n1c1 = c1, n1c2 = c2
 *   * P === node2: triple (node1, node2, T)   -> n2c1 = c1, n2c2 = c2
 *
 * When no continuation passes the threshold (genuine open-chain end), the handle
 * falls back to the edge midpoint.
 *
 * The identical values are written onto every faction's clone of the edge (see
 * the apply step in calculate-voronoi-borders.ts), so both sides of a shared
 * border paint one identical bezier curve. Interior chains (exactly one
 * continuation) compute exactly the same values the old loop-order code
 * produced; junction handles become symmetric by construction because both
 * clones pick the same global straightest continuation. Order-independent and
 * deterministic.
 */
export interface CanonicalEdgeControls {
  n1c1: Point2d;
  n1c2: Point2d;
  n2c1: Point2d;
  n2c2: Point2d;
}

/**
 * Builds canonical control points once per shared edge id.
 *
 * @param edgeMap one representative edge per edge id (all clones share ids and
 *   geometry, so one rep suffices to pick continuations)
 * @param threeWayNodes node id -> edge ids at genuine three-way junctions
 * @param tension control point tension
 * @param minimumDotProductForAdjacency minimum dot for the straightness test
 * @returns Map<edgeId, {n1c1,n1c2,n2c1,n2c2}>
 */
export function buildCanonicalEdgeControls(
  edgeMap: Record<string, VoronoiBorderEdge>,
  tension = DEFAULT_TENSION,
  minimumDotProductForAdjacency = DEFAULT_MIN_DOT,
): Map<string, CanonicalEdgeControls> {
  // Complete node -> edge ids index. threeWayNodes only indexes genuine
  // junctions (>2 affiliations); two-way chain nodes are needed here too.
  const nodeEdges = new Map<string, Array<string>>();
  for (const edge of Object.values(edgeMap)) {
    for (const node of [edge.node1, edge.node2]) {
      const list = nodeEdges.get(node.id) || [];
      if (!list.includes(edge.id)) list.push(edge.id);
      nodeEdges.set(node.id, list);
    }
  }

  const controls = new Map<string, CanonicalEdgeControls>();
  for (const [edgeId, edge] of Object.entries(edgeMap)) {
    const atNode1 = controlsAtNode(edge, 'node1', edgeMap, nodeEdges, tension, minimumDotProductForAdjacency);
    const atNode2 = controlsAtNode(edge, 'node2', edgeMap, nodeEdges, tension, minimumDotProductForAdjacency);
    const midpoint = {
      x: (edge.node1.x + edge.node2.x) / 2,
      y: (edge.node1.y + edge.node2.y) / 2,
    };
    controls.set(edgeId, {
      n1c1: atNode1 ? atNode1.c1 : midpoint,
      n1c2: atNode1 ? atNode1.c2 : midpoint,
      n2c1: atNode2 ? atNode2.c1 : midpoint,
      n2c2: atNode2 ? atNode2.c2 : midpoint,
    });
  }
  return controls;
}

/**
 * Control points at one node of an edge, derived from the canonical continuation.
 * Returns null when no continuation passes the dot threshold (open-chain end).
 */
function controlsAtNode(
  edge: VoronoiBorderEdge,
  pivot: 'node1' | 'node2',
  edgeMap: Record<string, VoronoiBorderEdge>,
  nodeEdges: Map<string, Array<string>>,
  tension: number,
  minimumDotProductForAdjacency: number,
): { c1: Point2d; c2: Point2d } | undefined {
  const continuation = findContinuation(edge, pivot, nodeEdges, edgeMap, minimumDotProductForAdjacency);
  if (!continuation) return undefined;

  const pivotNode = edge[pivot];
  const otherNode = pivot === 'node1' ? edge.node2 : edge.node1;
  // pivot node1: triple (T, node1, node2) ; pivot node2: triple (node1, node2, T)
  const p1 = pivot === 'node1' ? continuation : otherNode;
  const p2 = pivotNode;
  const p3 = pivot === 'node1' ? otherNode : continuation;
  return generateBezierControlPoints(p1, p2, p3, tension);
}

/**
 * Straightest adjacent edge at `pivot` other than `edge` itself, mirroring the
 * dot-product straightness test of the previous findStraightestAdjacentEdge.
 * Returns the continuation edge's far node (T), or null.
 */
function findContinuation(
  edge: VoronoiBorderEdge,
  pivot: 'node1' | 'node2',
  nodeEdges: Map<string, Array<string>>,
  edgeMap: Record<string, VoronoiBorderEdge>,
  minimumDotProductForAdjacency: number,
): Point2d | undefined {
  const pivotNode = edge[pivot];
  const otherNode = pivot === 'node1' ? edge.node2 : edge.node1;
  const candidates = (nodeEdges.get(pivotNode.id) || []).filter((id) => id !== edge.id);
  if (candidates.length === 0) return undefined;

  const edgeNodeIds = edge.id.split('-');
  let bestDot = -Infinity;
  let bestT: Point2d | undefined;

  for (const candId of candidates) {
    const cand = edgeMap[candId];
    if (!cand) continue;
    const candNodeIds = cand.id.split('-');
    const commonNodeId = edgeNodeIds.filter((nid) => candNodeIds.includes(nid))[0];
    if (!commonNodeId) continue;
    const continuationNode = cand.node1.id === commonNodeId ? cand.node2 : cand.node1;

    let n1: Point2d;
    let n2: Point2d;
    let n3: Point2d;
    if (pivot === 'node1') {
      n1 = continuationNode;
      n2 = pivotNode;
      n3 = otherNode;
    } else {
      n1 = otherNode;
      n2 = pivotNode;
      n3 = continuationNode;
    }
    const v1 = { a: n2.x - n1.x, b: n2.y - n1.y };
    const v2 = { a: n3.x - n2.x, b: n3.y - n2.y };
    normalizeVector(v1);
    normalizeVector(v2);
    const dot = dotProduct(v1, v2);
    if (dot > bestDot && dot >= minimumDotProductForAdjacency) {
      bestDot = dot;
      bestT = continuationNode;
    }
  }
  return bestT;
}

/**
 * Applies canonical edge-centric control points to every faction's clone of each
 * shared edge, so all clones of an edge carry identical handles.
 *
 * The two faction clones of a shared border traverse it in opposite directions
 * (one reversed), so handles are mapped by node identity: a clone whose node1
 * is the canonical edge's node2 receives the canonical node2 handles at its n1
 * fields, and vice versa. Same-orientation clones get a straight copy.
 *
 * @param borderLoops all factions' border loops (clones of the shared edges)
 * @param canonicalControls output of buildCanonicalEdgeControls
 * @param edgeMap one representative edge per edge id (used to determine each
 *   clone's orientation relative to the canonical representative)
 */
export function applyCanonicalEdgeControls(
  borderLoops: Record<string, Array<BorderEdgeLoop>>,
  canonicalControls: Map<string, CanonicalEdgeControls>,
  edgeMap: Record<string, VoronoiBorderEdge>,
): void {
  for (const loops of Object.values(borderLoops)) {
    for (const loop of loops) {
      for (const edge of loop.edges) {
        const c = canonicalControls.get(edge.id);
        const rep = edgeMap[edge.id];
        if (!c || !rep) continue;
        const sameOrientation = edge.node1.id === rep.node1.id;
        if (sameOrientation) {
          edge.n1c1 = c.n1c1;
          edge.n1c2 = c.n1c2;
          edge.n2c1 = c.n2c1;
          edge.n2c2 = c.n2c2;
        } else {
          // Reversed clone: its node1 is the rep's node2 and vice versa.
          edge.n1c1 = c.n2c2;
          edge.n1c2 = c.n2c1;
          edge.n2c1 = c.n1c2;
          edge.n2c2 = c.n1c1;
        }
      }
    }
  }
}
