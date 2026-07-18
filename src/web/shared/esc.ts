/** HTML-escape a string for safe interpolation into innerHTML. Used for all
 *  operator-supplied text (camera/angle names, log fields) rendered on the pages. */
export const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!,
  );
