/** Strip \r and \n from text to prevent IRC protocol injection. */
export function sanitize(text: string): string {
  return text.replace(/[\r\n]/g, '');
}
