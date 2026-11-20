import { Point2d } from './types';

const DEFAULT_TOLERANCE = 1e-9;

/**
 * Returns true if two points are within `tolerance` map units
 * using Euclidean distance.
 */
export function pointsAreClose(p1: Point2d, p2: Point2d, tolerance: number): boolean {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  return (dx * dx + dy * dy) <= (tolerance * tolerance);
}

/**
 * Checks for point equality using a very small default tolerance.
 */
export function pointsAreEqual(p1: Point2d, p2: Point2d): boolean {
  return pointsAreClose(p1, p2, DEFAULT_TOLERANCE);
}
