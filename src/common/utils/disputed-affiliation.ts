/**
 * Single source of truth for disputed-affiliation detection and parsing.
 *
 * Known disputed forms across the pipeline:
 * - `D` (bare)
 * - `D(FS|LC)`, `D(FS/LC)`, `D(FS,LC)` (parenthesized; separators `|`, `/`, `,`)
 * - `D-FS-LC`, `D-FS/LC`, `D-FS|LC` (dash-prefixed; separators `-`, `/`, `|`, `,`)
 *
 * Previously each call site used its own ad-hoc test (`includes('/')`,
 * `/^D[-(]/`, `startsWith('D-')`, ...), so dash-form disputed edges were
 * relaxed/simplified when they should have stayed pinned, and disputed
 * punch-holes missed parents. All call sites must use these helpers.
 */

/** True for any disputed affiliation key in any known form. */
export function isDisputedAffiliation(key: string | undefined | null): boolean {
  if (!key) return false;
  const k = key.trim();
  if (/^D$/i.test(k)) return true;
  if (/^D\(/i.test(k)) return true;
  if (/^D-/i.test(k)) return true;
  return false;
}

/**
 * Sub-faction ids of a disputed key, upper-cased (e.g. `D-FS/LC` → `['FS','LC']`).
 * Returns `[]` for non-disputed keys or unparseable forms.
 */
export function parseDisputedSubFactions(key: string | undefined | null): string[] {
  if (!key) return [];
  const k = key.trim();
  if (/^D$/i.test(k)) return [];
  const paren = k.match(/^D\(([^)]+)\)$/i);
  if (paren) {
    return paren[1]
      .split(/[-|/,]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.toUpperCase());
  }
  const dashed = k.match(/^D-(.+)$/i);
  if (dashed) {
    return dashed[1]
      .replace(/^\(|\)$/g, '')
      .split(/[-|/,]/)
      .map((s) => s.trim().replace(/^\(|\)$/g, ''))
      .filter(Boolean)
      .map((s) => s.toUpperCase());
  }
  return [];
}

/** True when either side of a border edge touches a disputed zone. */
export function isDisputedZoneEdge(edge: { affiliation1: string; affiliation2: string }): boolean {
  return isDisputedAffiliation(edge.affiliation1) || isDisputedAffiliation(edge.affiliation2);
}
