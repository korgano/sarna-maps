import { expect, describe, it } from 'vitest';
import { renderBorderLoops } from './render-border-loops';
import { BorderEdgeLoop } from '../../../compute';
import { FactionRegistry } from '../../../common';

function node(id: string, x: number, y: number) {
  return {
    id,
    x,
    y,
    vertex1Idx: 0,
    vertex2Idx: 0,
    vertex3Idx: 0,
    neighborNodeIndices: [] as Array<number>,
    borderAffiliations: {},
  };
}

function edge(id: string, a: ReturnType<typeof node>, b: ReturnType<typeof node>, owner: string) {
  return {
    id,
    node1: a,
    node2: b,
    vertex1Idx: 0,
    vertex2Idx: 0,
    affiliation1: owner,
    affiliation2: 'OTHER',
    leftAffiliation: 'OTHER',
    rightAffiliation: owner,
    length: 10,
    closeness: 99,
  };
}

/** Closed square loop (0,0)-(10,10) owned by `owner`. */
function squareLoop(owner: string): BorderEdgeLoop {
  const n1 = node(`${owner}n1`, 0, 0);
  const n2 = node(`${owner}n2`, 10, 0);
  const n3 = node(`${owner}n3`, 10, 10);
  const n4 = node(`${owner}n4`, 0, 10);
  return {
    edges: [
      edge(`${owner}s1`, n1, n2, owner),
      edge(`${owner}s2`, n2, n3, owner),
      edge(`${owner}s3`, n3, n4, owner),
      edge(`${owner}s4`, n4, n1, owner),
    ],
    minEdgeIdx: 0,
    innerAffiliation: owner,
    outerAffiliation: 'OTHER',
  } as unknown as BorderEdgeLoop;
}

/** Extracts all path `d` attributes from markup for a given faction group. */
function factionPaths(markup: string, faction: string): Array<string> {
  const groupRe = new RegExp(`<g data-name="${faction}"[^>]*>([\\s\\S]*?)<\\/g>`);
  const group = groupRe.exec(markup);
  if (!group) return [];
  const paths: Array<string> = [];
  const pathRe = /<path[^>]*d="([^"]*)"[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = pathRe.exec(group[1])) !== null) {
    paths.push(match[1]);
  }
  return paths;
}

/** Extracts stroke path `d` attributes (style="fill: none") for a faction. */
function factionStrokePaths(markup: string, faction: string): Array<string> {
  const groupRe = new RegExp(`<g data-name="${faction}"[^>]*>([\\s\\S]*?)<\\/g>`);
  const group = groupRe.exec(markup);
  if (!group) return [];
  const paths: Array<string> = [];
  const pathRe = /<path[^>]*d="([^"]*)"[^>]*style="fill: none"[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = pathRe.exec(group[1])) !== null) {
    paths.push(match[1]);
  }
  return paths;
}

/** Extracts fill path `d` attributes (style="stroke: none") for a faction. */
function factionFillPaths(markup: string, faction: string): Array<string> {
  const groupRe = new RegExp(`<g data-name="${faction}"[^>]*>([\\s\\S]*?)<\\/g>`);
  const group = groupRe.exec(markup);
  if (!group) return [];
  const paths: Array<string> = [];
  const pathRe = /<path[^>]*d="([^"]*)"[^>]*style="stroke: none"[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = pathRe.exec(group[1])) !== null) {
    paths.push(match[1]);
  }
  return paths;
}

describe('fill/stroke geometry consistency', () => {
  const registry = new FactionRegistry();

  it('fills and strokes use identical geometry for the same faction', () => {
    // DC has a square loop (0,0)-(10,10).
    // Since fillLoops (pre-pull gapless) is used for BOTH fills and strokes,
    // the fill path and stroke path should have identical coordinates.
    const dc = squareLoop('DC');
    const fillLoops = { DC: [dc] };
    const borderLoops = { DC: [dc] };

    const result = renderBorderLoops(
      borderLoops,
      fillLoops,
      registry,
      new Map(),
      'light',
      false, // renderCurves = false for straight-line comparison
    );

    const dcStrokes = factionStrokePaths(result.markup, 'DC');
    const dcFills = factionFillPaths(result.markup, 'DC');

    // Both fills and strokes should exist.
    expect(dcStrokes.length).toBeGreaterThan(0);
    expect(dcFills.length).toBeGreaterThan(0);

    // Concatenate all stroke paths and all fill paths for DC.
    // Since both use the same geometry (fillLoops), their coordinate
    // sequences should match exactly (same M/L commands, same numbers).
    const dcStrokeCoords = dcStrokes.join(' ');
    const dcFillCoords = dcFills.join(' ');

    // Strip the leading M command and trailing Z close command to compare
    // just the coordinate sequences.
    const strokeCoords = dcStrokeCoords.replace(/^M/, '').replace(/ Z$/, '');
    const fillCoords = dcFillCoords.replace(/^M/, '').replace(/ Z$/, '');

    expect(strokeCoords).toBe(fillCoords);
  });

  it('every faction with borders has both fill and stroke paths', () => {
    const dc = squareLoop('DC');
    const result = renderBorderLoops(
      { DC: [dc] },
      { DC: [dc] },
      registry,
      new Map(),
      'light',
      false,
    );

    expect(factionFillPaths(result.markup, 'DC').length).toBeGreaterThan(0);
    expect(factionStrokePaths(result.markup, 'DC').length).toBeGreaterThan(0);
  });
});
