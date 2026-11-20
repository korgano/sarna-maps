import { BorderSection } from '../types';
import { logger, distance, pointsAreClose, Point2d } from '../../../common';
import { reverseEdges } from './utils';
import { EMPTY_FACTION, INDEPENDENT } from '../../constants';

const MERGE_EPSILON = 0.5;
// Sections whose endpoints are farther apart than this are never merged, even
// if they share a parent affiliation. Prevents geographically distant same-faction
// regions (e.g. CFG around Diosd vs CFG around Karbala, ~40 map units apart)
// from being folded into one overextended region just because they share a
// faction prefix. Merging requires physical adjacency — endpoints within
// MERGE_EPSILON — so this cap is a backstop for edge cases where floating-point
// drift could otherwise bridge a real gap.
const MAX_MERGE_DISTANCE = 30.0;

function snapPoint(a: Point2d, b: Point2d) {
  a.x = b.x;
  a.y = b.y;
}

function tryMergeTwo(
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

/**
 * Merges border sections so that the largest sections are stitched together as loops.
 * @param sections The border sections (will be modified)
 * @param hierarchyLevelIndex The hierarchy level of the sections to merge
 */
export function mergeBorderSections(sections: Array<BorderSection>, hierarchyLevelIndex: number) {
  sections.sort((a, b) =>
    a.primaryAffiliation === INDEPENDENT || a.primaryAffiliation === EMPTY_FACTION || (a.affiliation1 === EMPTY_FACTION && a.affiliation2 === INDEPENDENT)
      ? 1
      : b.primaryAffiliation === INDEPENDENT || (b.affiliation1 === EMPTY_FACTION && b.affiliation2 === INDEPENDENT)
      ? -1
      : a.affiliation1 === EMPTY_FACTION || a.affiliation2 === EMPTY_FACTION
      ? 1
      : b.affiliation1 === EMPTY_FACTION || b.affiliation2 === EMPTY_FACTION
      ? -1
      : b.edges.length - a.edges.length,
  );

  const removed = new Set<number>();

  for (let i = 0; i < sections.length; i++) {
    if (removed.has(i)) continue;

    for (let j = i + 1; j < sections.length; j++) {
      if (removed.has(j)) continue;

      const iParentAffiliations = [
        sections[i].affiliation1.split(',').slice(0, hierarchyLevelIndex).join(','),
        sections[i].affiliation2.split(',').slice(0, hierarchyLevelIndex).join(','),
      ].sort().join('|');
      const jParentAffiliations = [
        sections[j].affiliation1.split(',').slice(0, hierarchyLevelIndex).join(','),
        sections[j].affiliation2.split(',').slice(0, hierarchyLevelIndex).join(','),
      ].sort().join('|');
      if (iParentAffiliations !== jParentAffiliations) {
        continue;
      }

      // Geographic proximity guard: sections must be near each other to merge.
      // Distant same-faction regions (e.g. CFG Diosd vs CFG Karbala at ~40 mu)
      // are never merged just because they share a faction prefix — each keeps
      // its own region, leaving room for Lothan's DC territory between them.
      const iCenter = {
        x: (sections[i].node1.x + sections[i].node2.x) / 2,
        y: (sections[i].node1.y + sections[i].node2.y) / 2,
      };
      const jCenter = {
        x: (sections[j].node1.x + sections[j].node2.x) / 2,
        y: (sections[j].node1.y + sections[j].node2.y) / 2,
      };
      if (distance(iCenter, jCenter) > MAX_MERGE_DISTANCE) {
        continue;
      }

      const commonAffiliations = [sections[i].affiliation1, sections[i].affiliation2].filter(
        (aff) => [sections[j].affiliation1, sections[j].affiliation2].includes(aff)
          && aff !== EMPTY_FACTION && aff !== INDEPENDENT,
      );

      if (
        commonAffiliations.length === 0 ||
        (sections[i].primaryAffiliation && !commonAffiliations.includes(sections[i].primaryAffiliation as string)) ||
        (commonAffiliations.length === 1 && commonAffiliations[0] === EMPTY_FACTION)
      ) {
        continue;
      }
      // Only merge sections with the exact same affiliation pair (sorted).
      // Cross-pair merging (e.g. TC-FS + TC-DC → mixed section) produces
      // loops containing edges from different boundary pairs, causing
      // overlapping fills and misplaced borders.
      const iPair = [sections[i].affiliation1, sections[i].affiliation2].sort().join('___');
      const jPair = [sections[j].affiliation1, sections[j].affiliation2].sort().join('___');
      if (iPair !== jPair) {
        continue;
      }
      if (!sections[i].primaryAffiliation) {
        sections[i].primaryAffiliation = commonAffiliations[0];
      }

      if (tryMergeTwo(sections[i], sections[j])) {
        sections[i].node1 = sections[i].edges[0].node1;
        sections[i].node2 = sections[i].edges[sections[i].edges.length - 1].node2;
        sections[i].isLoop = pointsAreClose(sections[i].node1, sections[i].node2, MERGE_EPSILON);
        removed.add(j);
      }
    }
  }

  const active = sections.filter((_, i) => !removed.has(i));
  sections.length = 0;
  sections.push(...active);
  return sections;
}
