import { generateCode, validateCustomCode } from "./code.js";
import { RateLimiter } from "./ratelimit.js";
import { LinkStore } from "./store.js";
import { validateUrl } from "./url.js";

export interface Ctx {
  method: string;
  path: string;
  body?: unknown;
  ip: string;
  referrer?: string;
  now: number;
  baseUrl?: string;
}

export interface Res {
  status: number;
  json?: unknown;
  redirect?: string;
  headers?: Record<string, string>;
}

export interface Deps {
  store: LinkStore;
  limiter: RateLimiter;
  newCode?: () => string;
}

const err = (status: number, error: string, headers?: Record<string, string>): Res => ({ status, json: { error }, headers });

function hostOf(ref?: string): string {
  if (!ref) return "direct";
  try { return new URL(ref).hostname || "direct"; } catch { return "direct"; }
}

/** Framework-independent request handler, so the whole API can be tested without a server. */
export function handle(ctx: Ctx, { store, limiter, newCode = () => generateCode() }: Deps): Res {
  const { method, path } = ctx;

  if (method === "GET" && path === "/api/health") return { status: 200, json: { ok: true } };

  if (path === "/api/links") {
    if (method === "GET") {
      return { status: 200, json: { links: store.list().map(({ recent: _r, ...l }) => l) } };
    }
    if (method === "POST") {
      const rl = limiter.check(ctx.ip, ctx.now);
      if (!rl.allowed) return err(429, "Too many requests. Try again shortly.", { "Retry-After": String(rl.retryAfterSec) });

      const body = (ctx.body ?? {}) as { url?: unknown; customCode?: unknown };
      const check = validateUrl(body.url);
      if (!check.ok) return err(400, check.error);

      let code: string;
      if (body.customCode !== undefined && body.customCode !== "") {
        if (typeof body.customCode !== "string") return err(400, "customCode must be a string.");
        const problem = validateCustomCode(body.customCode);
        if (problem) return err(400, problem);
        if (store.has(body.customCode)) return err(409, "That custom code is already taken.");
        code = body.customCode;
      } else {
        const existing = store.findByUrl(check.url);
        if (existing) return { status: 200, json: view(existing.code, existing.url, existing.createdAt, ctx.baseUrl) };
        code = newCode();
        for (let i = 0; store.has(code) && i < 5; i++) code = newCode(); // collision retry
        if (store.has(code)) return err(500, "Couldn't allocate a short code. Try again.");
      }
      const link = store.create(code, check.url, ctx.now);
      return { status: 201, json: view(link.code, link.url, link.createdAt, ctx.baseUrl) };
    }
    return err(405, "Method not allowed.");
  }

  const stats = path.match(/^\/api\/links\/([^/]+)\/stats$/);
  if (stats) {
    if (method !== "GET") return err(405, "Method not allowed.");
    const s = store.stats(decodeURIComponent(stats[1]), ctx.now);
    return s ? { status: 200, json: s } : err(404, "No link with that code.");
  }

  const code = path.match(/^\/([A-Za-z0-9_-]{1,32})$/);
  if (code && method === "GET") {
    const link = store.get(code[1]);
    if (!link) return err(404, "Short link not found.");
    store.recordClick(link.code, hostOf(ctx.referrer), ctx.now);
    return { status: 302, redirect: link.url };
  }

  return err(404, "Not found.");
}

function view(code: string, url: string, createdAt: number, baseUrl = "") {
  return { code, url, shortUrl: `${baseUrl}/${code}`, createdAt };
}
