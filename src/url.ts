export type UrlCheck = { ok: true; url: string } | { ok: false; error: string };

const BLOCKED_HOSTS = new Set(["localhost", "0.0.0.0", "[::1]", "[::]"]);

function isPrivateIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 10 || a === 127 || a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** Accept only public http(s) URLs. Rejects credentials, localhost and private ranges (SSRF/abuse guard). */
export function validateUrl(input: unknown): UrlCheck {
  if (typeof input !== "string" || !input.trim()) return { ok: false, error: "Provide a url as a string." };
  const raw = input.trim();
  if (raw.length > 2048) return { ok: false, error: "URL is too long (max 2048 characters)." };

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: "That doesn't look like a valid URL. Include https://." };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "Only http and https links are allowed." };
  if (u.username || u.password) return { ok: false, error: "URLs with embedded credentials are not allowed." };

  const host = u.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".localhost") || host.endsWith(".local") || isPrivateIPv4(host)) {
    return { ok: false, error: "Links to local or private addresses are not allowed." };
  }
  return { ok: true, url: u.toString() };
}
