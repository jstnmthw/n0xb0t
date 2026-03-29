/** Strip \r, \n, and NUL from text to prevent IRC protocol injection. */
export function sanitize(text: string): string {
  return text.replace(/[\r\n\0]/g, '');
}
