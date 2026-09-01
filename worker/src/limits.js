// Shared limits. In their own module because the Worker entrypoint may only
// export request handlers - a named constant exported from index.js makes
// workerd refuse the script with "not of type 'function or ExportedHandler'".

// The browser sends TEXT and nothing else. Never a bitmap, never raw bytes:
// otherwise moderation is one base64 blob away from being irrelevant.
export const MAX_TEXT_LENGTH = 200;

/**
 * How tall a ticket a stranger may cause, in printer lines. 8 lines to the
 * millimetre, so 600 is 7.5 cm.
 *
 * This is NOT the same limit as MAX_LINES in jobs.js, and conflating them was
 * a real hole. MAX_LINES is 1024 because that is what the Pico can hold in RAM
 * before it cuts WiFi - a memory bound. This one is a paper policy.
 *
 * The gap between them was worth about twelve centimetres. Two hundred
 * characters of ordinary prose render to ~310 lines, but two hundred
 * characters that are mostly newlines rendered to 5 847 - and anything under
 * 1024 was accepted, so thirty newlines bought a ticket four times the normal
 * size, three times a day, from every address on the internet.
 *
 * 600 leaves room for a message with real paragraph breaks and refuses the
 * ones whose only content is blank space.
 */
export const MAX_PUBLIC_LINES = 600;

/**
 * Collapses the blank space a submission can carry.
 *
 * A blank line between two paragraphs is how people write. Ten in a row is how
 * people waste someone else's paper, and the character budget does not stop
 * them: 199 newlines fit inside 200 characters.
 *
 * Runs of spaces go too - the renderer's word wrap keeps them, and they cost
 * lines just as newlines do.
 */
export function tidy(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[^\S\n]+/g, " ") // any horizontal whitespace run -> one space
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Threads handles are Instagram handles: letters, digits, dots, underscores,
 * thirty characters. That is the whole rule, and it is worth enforcing rather
 * than trusting, because whatever comes out of here gets printed on paper.
 */
export const MAX_HANDLE_LENGTH = 30;

/**
 * Cleans an optional handle, or returns null.
 *
 * The character whitelist is doing most of the safety work here. No spaces
 * means no sentences, no unicode means no confusables, and thirty characters
 * means one line. What survives is a name, which is all the field is for.
 *
 * Returns undefined when the input was not empty but cannot be salvaged, so
 * the caller can tell "left blank" apart from "typed something impossible".
 */
export function tidyHandle(raw) {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim().replace(/^@+/, "").toLowerCase();
  if (!trimmed) return null;
  if (trimmed.length > MAX_HANDLE_LENGTH) return undefined;
  if (!/^[a-z0-9._]+$/.test(trimmed)) return undefined;
  // A handle that is only punctuation is not a handle.
  if (!/[a-z0-9]/.test(trimmed)) return undefined;
  return trimmed;
}
