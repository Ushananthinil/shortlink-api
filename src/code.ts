import { randomInt } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export const RESERVED = new Set(["api", "health", "admin", "static", "favicon.ico"]);

/** Cryptographically random base62 code. 62^7 is about 3.5 trillion combinations. */
export function generateCode(length = 7, rand: (max: number) => number = randomInt): string {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[rand(ALPHABET.length)];
  return out;
}

export function validateCustomCode(code: string): string | null {
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(code)) return "Custom codes must be 3-32 characters: letters, numbers, - or _.";
  if (RESERVED.has(code.toLowerCase())) return "That code is reserved. Choose another.";
  return null;
}
