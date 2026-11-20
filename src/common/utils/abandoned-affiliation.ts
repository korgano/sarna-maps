/**
 * Single source of truth for abandoned-system affiliation parsing.
 *
 * Known abandoned forms (first token of an era affiliation):
 * - `A` (bare) — abandoned system with NO border participation:
 *   dot and label use the abandoned style, Voronoi/borders ignore it.
 * - `A(<FACTION>)` — abandoned system WITHIN <FACTION>'s border:
 *   dot and label STILL use the abandoned style (never the faction's),
 *   but the system is a full border participant of <FACTION>
 *   (v3 borderID = <FACTION>).
 * - Hierarchy tails after the first token are preserved by callers
 *   (`A(CFG)|District` v3 / `A(CFG),District` v1); only the first token
 *   determines abandoned-ness and the border faction.
 *
 * All call sites must use these helpers instead of ad-hoc `/^A/` tests —
 * faction ids like `AuC` start with "A" but are NOT abandoned.
 */

const ABANDONED_TOKEN_REGEX = /^([A-Za-z0-9\-]+)\s*(?:\(([^)]+)\))?/;

/** True for any abandoned affiliation key: bare `A` or `A(<FACTION>)`. */
export function isAbandonedAffiliation(affiliation: string | undefined | null): boolean {
  if (!affiliation) return false;
  const match = affiliation.trim().match(ABANDONED_TOKEN_REGEX);
  return !!match && match[1].toUpperCase() === 'A';
}

/**
 * The border faction of an abandoned affiliation — the `<FACTION>` inside
 * `A(<FACTION>)`, returned as written (case preserved, e.g. `A(AuC)` → `AuC`).
 * Returns `''` for bare `A`, non-abandoned keys, and the hidden marker
 * (`A(H)` is hidden, not faction-bearing).
 */
export function getAbandonedBorderFaction(affiliation: string | undefined | null): string {
  if (!affiliation) return '';
  const match = affiliation.trim().match(ABANDONED_TOKEN_REGEX);
  if (!match || match[1].toUpperCase() !== 'A') return '';
  const faction = (match[2] || '').trim();
  if (!faction || faction.toUpperCase() === 'H') return '';
  return faction;
}
