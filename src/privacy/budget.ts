// Size limits for text sent to the decision backend or kept in logs. Counted in code points, and never cutting a
// surrogate pair in half. Pure.

const ELISION = "\n[…]\n";

/** Keeps the head and the tail (the actual ask is often at the end). */
export function headTail(text: string, max: number): string {
  const cps = Array.from(text);
  if (cps.length <= max) return text;
  const room = Math.max(0, max - Array.from(ELISION).length);
  const head = Math.ceil(room / 2);
  return cps.slice(0, head).join("") + ELISION + cps.slice(cps.length - (room - head)).join("");
}

/** Keeps the end only (the end of the previous reply is what the user reacts to). */
export function tail(text: string, max: number): string {
  const cps = Array.from(text);
  return cps.length <= max ? text : cps.slice(cps.length - max).join("");
}

/** Keeps the start only. */
export function head(text: string, max: number): string {
  const cps = Array.from(text);
  return cps.length <= max ? text : cps.slice(0, max).join("");
}
