/**
 * Centralized mapping of capital descriptor tokens to numeric levels.
 *
 * Both the v1 comma-delimited and v3 pipe-delimited affiliation formats embed
 * a capital descriptor (e.g. "national capital", "minor capital") as one of
 * their tokens. The numeric level drives downstream rendering (decoration
 * rings) and label placement (margin and capital-label additions).
 *
 * Level 1 = highest prominence (national / faction capital)
 * Level 2 = major capital
 * Level 3 = lowest prominence (minor / district / region capital)
 * 0       = not a capital
 */
export const CAPITAL_LEVELS: Record<string, number> = {
  'national capital': 1,
  'faction capital': 1,
  'major capital': 2,
  'minor capital': 3,
  'district capital': 3,
  'region capital': 3,
};
