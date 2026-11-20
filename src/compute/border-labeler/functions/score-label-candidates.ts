import { BorderLabelCandidate } from "../types";
import { BorderEdgeLoop } from '../../voronoi-border';
import { BorderLabelConfig, BorderLabelVariant, logger, RectangleGrid } from '../../../common';
import { calculateCandidateLoopOverlap, precomputeEdgeMidpoints } from './calculate-candidate-loop-overlap';
import { calculateCandidateLabelOverlap } from './calculate-candidate-label-overlap';

/**
 * Calculate the score for each of the given candidates and add it to the candidate object, in-place.
 * A candidate's score lies between 0 and 1, and is calculated using different criteria as defined in
 * the border labels config file
 *
 * @param candidates The candidates to score
 * @param loop The border edge loop the labels will be placed on
 * @param grid The pre-existing label grid to use for checking label/object overlaps
 * @param borderLabelConfig The border label config object
 */
export function scoreLabelCandidates(
  candidates: Array<BorderLabelCandidate>,
  loop: BorderEdgeLoop,
  grid: RectangleGrid,
  borderLabelConfig: BorderLabelConfig,
) {
  if (candidates.length === 0) {
    return;
  }

  // normalize the configured weights so that they sum to 1
  const weightsSum = Object.values(borderLabelConfig.scoreWeights)
    .reduce((sum, currentValue) => sum + currentValue, 0);
  const normalizedWeights = { ...borderLabelConfig.scoreWeights };
  Object.keys(normalizedWeights).forEach(
    (key: keyof typeof normalizedWeights) => normalizedWeights[key] = normalizedWeights[key] / weightsSum,
  );

  // find the maximum area that candidates can overlap (only first 3 candidates as reference)
  const maximumLabelOverlapArea = candidates.slice(0, 3)
    .reduce((max, c) => Math.max(max, c.labelArea), 0);

  const maximumLoopOverlap = candidates.slice(0, 3)
    .reduce((max, c) => Math.max(max, c.borderSectionStraightness), 0);

  // compute maximum straightness with a single pass (no intermediate array allocation)
  let maximumStraightness = 0;
  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i].borderSectionStraightness > maximumStraightness) {
      maximumStraightness = candidates[i].borderSectionStraightness;
    }
  }

  // Precompute edge midpoints once for the entire loop (avoids per-candidate allocation)
  const edgeMidpoints = precomputeEdgeMidpoints(loop);

  candidates.forEach((candidate) => {
    // determine whether the candidate overlaps any loop edges, and by how much approximately
    calculateCandidateLoopOverlap(candidate, loop, borderLabelConfig.rules.maxBorderIntersectionDistance, edgeMidpoints);

    // Skip expensive label overlap calculation if already disqualified by border intersection
    if ((candidate.loopOverlapDistance || 0) <= borderLabelConfig.rules.maxBorderIntersectionDistance) {
      calculateCandidateLabelOverlap(candidate, grid);
    }

    // at this point, our candidate contains all necessary information to score it
    // rate the overlap area
    let overlapRating = 1 - Math.min(
      1,
      8 * (candidate.labelOverlapArea || 0) / maximumLabelOverlapArea, // TODO magic number
    );
    overlapRating *= normalizedWeights.labelOverlap;
    if ((candidate.labelOverlapArea || 0) > borderLabelConfig.rules.maxLabelOverlapArea) {
      candidate.disqualified = true;
      candidate.disqualificationReason = `label overlap (${candidate.labelOverlapArea})`;
    }

    // rate the label's angle
    let simplifiedAngle = candidate.labelAngle % 180;
    if (simplifiedAngle > 90) {
      simplifiedAngle = 180 - simplifiedAngle;
    }
    let angleRating = simplifiedAngle <= 45
      ? -simplifiedAngle/45 + 1
      : (simplifiedAngle - 45) * 0.75 / 45;
    angleRating *= normalizedWeights.angle;

    // rate the straightness
    let straightnessRating = 1 - candidate.borderSectionStraightness / maximumStraightness;
    straightnessRating *= normalizedWeights.straightness;

    // rate the border intersection distance
    let borderIntersectionRating =
      (candidate.loopOverlapDistance || 0) <= borderLabelConfig.rules.borderIntersectionTolerance
        ? 1
        : Math.max(0, 1 - 5 * (candidate.loopOverlapDistance || 0) / maximumLoopOverlap // TODO magic number (factor)
    );
    borderIntersectionRating *= normalizedWeights.borderIntersection;
    if ((candidate.loopOverlapDistance || 0) > borderLabelConfig.rules.maxBorderIntersectionDistance) {
      candidate.disqualified = true;
      candidate.disqualificationReason = `border intersection (${candidate.loopOverlapDistance})`;
    }

    // rate the centeredness
    let centerednessRating = candidate.centeredness * normalizedWeights.centeredness;

    // use the previously calculated cornerScore
    let cornerScoreRating = candidate.cornerScore * normalizedWeights.cornerScore;

    // rate the multilined-ness
    let multilineRating = candidate.labelVariant === BorderLabelVariant.MultiLine
      ? 1
      : candidate.labelVariant === BorderLabelVariant.SingleLine
        ? .8
        : 0;
    multilineRating *= normalizedWeights.multiline;

    candidate.score = overlapRating + angleRating + straightnessRating +
      borderIntersectionRating + centerednessRating + cornerScoreRating + multilineRating;

    if (candidate.score < 0 || candidate.score > 1) {
      logger.warn(
        'Border label candidate has a score that should be impossible, please check:',
        candidate.id,
        candidate.score,
      );
    }
  });
}
