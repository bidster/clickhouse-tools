const TSV_ESCAPES: Record<string, string> = {
  '\\': '\\\\',
  '\t': '\\t',
  '\n': '\\n',
  '\r': '\\r',
};

/** Escape a string once before passing it to UnescapedTsvRowEncoder. */
export function escapeTsvString(value: string): string {
  // String.length counts UTF-16 code units; longer strings keep four replaces.
  if (value.length <= 128) {
    return /[\\\t\n\r]/.test(value)
      ? value.replace(/[\\\t\n\r]/g, (character) => TSV_ESCAPES[character])
      : value;
  }
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}
