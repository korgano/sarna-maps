/**
 * Shared maintenance helpers for the `threeWayNodes` index
 * (node id → adjacent border-edge ids) across simplify passes.
 *
 * Every pass that removes, merges, or splits edges must keep the index in
 * sync; stale ids surface downstream as `Edge "X" no longer exists` warnings
 * in control-point generation and silently degrade curve smoothing to
 * midpoint fallbacks.
 */

/**
 * Retires a removed/superseded edge id across ALL node entries, replacing it
 * with its surviving successor id(s). No-op when the old id is absent.
 */
export function replaceEdgeId(
  threeWayNodes: Record<string, Array<string>>,
  oldId: string,
  ...newIds: Array<string>
): void {
  for (const key of Object.keys(threeWayNodes)) {
    const list = threeWayNodes[key];
    if (!list.includes(oldId)) continue;
    threeWayNodes[key] = [...list.filter((id) => id !== oldId), ...newIds.filter((id) => !list.includes(id))];
  }
}

/** Counter for simplify-created node ids (module scope: deterministic per run order). */
let createdNodeCounter = 0;

/**
 * Mints a fresh, globally-unique node id derived from a parent id.
 *
 * Simplify passes MUST NOT reuse an existing node's id for a newly created
 * point (e.g. edge midpoints): id reuse makes two physical points share one
 * identity, so endpoint matching later merges the wrong ends and whole
 * factions (e.g. FWL) collapse into uncloseable Franken-chains.
 */
export function freshNodeId(parentId: string): string {
  createdNodeCounter += 1;
  return `${parentId}n${createdNodeCounter}`;
}
