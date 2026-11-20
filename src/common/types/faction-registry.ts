import { Faction } from './faction';

/**
 * Centralized, case-insensitive faction lookup.
 *
 * Replaces scattered dual-key `factionMap` objects, `findFactionInsensitive`
 * helpers, and `buildFactionLookup` functions across the codebase.
 *
 * Register factions once (via `register`), then look up from any file via
 * `get(key)`. Mixed-case ids like `AuC` resolve whether the caller passes
 * `"AuC"`, `"AUC"`, or `"auc"`.
 *
 * Also handles abandoned-world wrapper keys: `A(CFG)` → inner faction `CFG`.
 */
export class FactionRegistry {
  /** Original-case key → Faction (preserves display id like "AuC") */
  private byId: Map<string, Faction> = new Map();
  /** Uppercase key → Faction (case-insensitive index) */
  private byUpper: Map<string, Faction> = new Map();
  /** All registered factions in insertion order */
  private all: Faction[] = [];

  /** Register a single faction under both its original id and uppercase form. */
  register(faction: Faction): void {
    this.byId.set(faction.id, faction);
    this.byUpper.set(faction.id.toUpperCase(), faction);
    this.all.push(faction);
  }

  /** Convenience: register an array of factions. */
  registerAll(factions: Faction[]): void {
    for (const f of factions) {
      this.register(f);
    }
  }

  /**
   * Look up a faction by key — tries the raw key first, then upper-cased.
   * Unwraps abandoned-world wrapper `A(FACTION)` → inner faction.
   * Returns `null` when no match is found.
   */
  get(key: string): Faction | null {
    if (!key) return null;

    // Unwrap abandoned-world keys: A(CFG) → CFG
    const abandonedMatch = key.match(/^A\(([^)]+)\)$/i);
    const lookupKey = abandonedMatch ? abandonedMatch[1] : key;

    const direct = this.byId.get(lookupKey);
    if (direct) return direct;

    return this.byUpper.get(lookupKey.toUpperCase()) ?? null;
  }

  /** Returns `true` when the key resolves to a registered faction. */
  has(key: string): boolean {
    return this.get(key) !== null;
  }

  /** All registered factions in insertion order. */
  getAll(): readonly Faction[] {
    return this.all;
  }

  /** All registered original-case faction ids. */
  keys(): string[] {
    return this.all.map(f => f.id);
  }

  /** Number of registered factions. */
  get size(): number {
    return this.all.length;
  }
}
