/**
 * Sanitizes a CSS color value for safe injection into SVG/CSS.
 *
 * Strips leading/trailing whitespace and newlines (which can occur when CSV
 * fields contain embedded line breaks inside quoted values), validates the
 * result as a hex color (#RRGGBB or #RGB), and returns a fallback color when
 * the value is invalid.
 *
 * This prevents malformed color values from corrupting CSS rules — for example,
 * a CSV color cell like `"\n#ff9e00"` (multi-line quoted field) would otherwise
 * be injected as `stroke: \n#ff9e00"` which CSS parses as `stroke: ` (empty),
 * causing the faction to render with default colors.
 *
 * @param color The raw color string from CSV or other data source
 * @param fallback The color to use when the input is invalid (default: '#999999')
 * @returns A valid hex color string safe for CSS injection
 */
export function sanitizeCssColor(color: string, fallback = '#999999'): string {
  if (!color) return fallback;

  // Strip all whitespace including newlines, tabs, spaces
  const trimmed = color.replace(/\s/g, '');

  // Validate hex color: #RRGGBB or #RGB (case-insensitive)
  if (/^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$/.test(trimmed)) {
    return trimmed;
  }

  return fallback;
}
