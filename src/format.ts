const graphemes = new Intl.Segmenter();
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}\p{Cc}]+$/u;
const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}️/u;
const WIDE =
  /^[ᄀ-ᅟ〈〉⺀-〾぀-㉇㉐-䶿一-꓆ꥠ-ꥼ가-힣豈-﫿︐-︙︰-﹫！-｠￠-￦\u{1B000}-\u{1B2FF}\u{1F200}-\u{1F251}\u{20000}-\u{3FFFD}]/u;

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (ZERO_WIDTH.test(segment)) continue;
    width += EMOJI.test(segment) || WIDE.test(segment) ? 2 : 1;
  }
  return width;
}

export function formatTable(rows: string[][]): string[] {
  const columns = rows[0].length - 1;
  const widths = Array.from({ length: columns }, (_, column) => Math.max(...rows.map((cells) => displayWidth(cells[column]))));
  return rows.map((cells) =>
    [...widths.map((width, column) => cells[column] + " ".repeat(width - displayWidth(cells[column]))), cells[columns]].join("  "),
  );
}
