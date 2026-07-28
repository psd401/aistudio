function isAsciiLetter(character: string | undefined): boolean {
  const code = character?.charCodeAt(0) ?? 0;
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function startsMarkup(input: string, index: number): boolean {
  const next = input[index + 1];
  return (
    isAsciiLetter(next) ||
    next === "!" ||
    next === "?" ||
    (next === "/" && isAsciiLetter(input[index + 2]))
  );
}

/**
 * Convert generated HTML to plain text in one pass.
 *
 * Unlike repeated tag-removal replacements, consuming a complete markup span
 * cannot expose a new tag assembled from the text around a removed substring.
 */
export function stripHtmlMarkup(input: string): string {
  let output = "";
  let inMarkup = false;
  let quote = "";

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (!inMarkup) {
      if (character === "<" && startsMarkup(input, index)) {
        inMarkup = true;
      } else {
        output += character;
      }
      continue;
    }

    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      inMarkup = false;
    }
  }

  return output;
}
