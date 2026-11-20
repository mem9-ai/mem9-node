// Walk backwards once instead of retrying an unanchored /[...]+$/ match at
// every input position. Do not truncate source text to avoid the backtracking.
export function trimTrailingCharacters(
  value: string,
  characters: string,
): string {
  let end = value.length;
  while (end > 0 && characters.includes(value.charAt(end - 1))) {
    end -= 1;
  }
  return value.slice(0, end);
}
