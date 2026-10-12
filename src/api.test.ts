import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCode, validateCustomCode } from "./code.js";
import { RateLimiter } from "./ratelimit.js";
import { Ctx, Deps, handle } from "./router.js";
import { LinkStore } from "./store.js";
import { validateUrl } from "./url.js";

const T0 = Date.UTC(2026, 0, 10, 12);
const make = (over: Partial<Deps> = {}): Deps => ({ store: new LinkStore(), limiter: new RateLimiter(5, 60_000), ...over });
const req = (method: string, path: string, extra: Partial<Ctx> = {}): Ctx => ({ method, path, ip: "1.1.1.1", now: T0, ...extra });
const post = (deps: Deps, body: unknown, extra: Partial<Ctx> = {}) => handle(req("POST", "/api/links", { body, ...extra }), deps);

test("generateCode: length, alphabet, and uses injected rng", () => {
  assert.match(generateCode(7), /^[A-Za-z0-9]{7}$/);
  assert.equal(generateCode(3, () => 0), "AAA");
});

test("custom codes: format and reserved words", () => {
  assert.equal(validateCustomCode("my-link_1"), null);
  assert.ok(validateCustomCode("ab"));
  assert.ok(validateCustomCode("has space"));
  assert.ok(validateCustomCode("API"));
});

test("validateUrl accepts public http(s) and normalizes", () => {
  const r = validateUrl("https://Example.com/a?b=1");
  assert.deepEqual(r, { ok: true, url: "https://example.com/a?b=1" });
});

test("validateUrl rejects bad schemes, credentials, and private targets", () => {
  for (const bad of [
    "javascript:alert(1)", "ftp://x.com", "not a url", "", 42,
    "https://user:pw@example.com", "http://localhost:3000", "http://127.0.0.1", "http://10.0.0.5",
    "http://192.168.1.1", "http://172.20.0.1", "http://169.254.169.254/latest/meta-data", "http://printer.local",
  ]) {
    assert.equal(validateUrl(bad).ok, false, String(bad));
  }
  assert.equal(validateUrl("http://172.32.0.1").ok, true); // outside 172.16/12
  assert.equal(validateUrl("https://example.com/" + "a".repeat(2100)).ok, false);
});

test("rate limiter: blocks over the limit, then recovers after the window", () => {
  const rl = new RateLimiter(2, 1000);
  assert.ok(rl.check("a", 0).allowed);
  assert.ok(rl.check("a", 100).allowed);
  const blocked = rl.check("a", 200);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSec, 1);
  assert.ok(rl.check("b", 200).allowed, "other keys unaffected");
  assert.ok(rl.check("a", 1100).allowed, "window slid past first hit");
});

test("POST creates a link (201) and is idempotent for the same URL (200)", () => {
  const deps = make({ newCode: () => "abc1234" });
  const a = post(deps, { url: "https://example.com/page" }, { baseUrl: "https://sho.rt" });
  assert.equal(a.status, 201);
  assert.deepEqual((a.json as { shortUrl: string }).shortUrl, "https://sho.rt/abc1234");
  const b = post(deps, { url: "https://example.com/page" });
  assert.equal(b.status, 200);
  assert.equal((b.json as { code: string }).code, "abc1234");
});

test("POST validates input and handles custom code conflicts", () => {
  const deps = make();
  assert.equal(post(deps, { url: "http://localhost" }).status, 400);
  assert.equal(post(deps, undefined).status, 400);
  assert.equal(post(deps, { url: "https://a.com", customCode: "hi" }).status, 400);
  assert.equal(post(deps, { url: "https://a.com", customCode: "docs" }).status, 201);
  assert.equal(post(deps, { url: "https://b.com", customCode: "docs" }).status, 409);
});

test("POST is rate limited per IP with Retry-After", () => {
  const deps = make({ limiter: new RateLimiter(2, 60_000) });
  assert.equal(post(deps, { url: "https://a.com/1" }).status, 201);
  assert.equal(post(deps, { url: "https://a.com/2" }).status, 201);
  const third = post(deps, { url: "https://a.com/3" });
  assert.equal(third.status, 429);
  assert.ok(third.headers?.["Retry-After"]);
  assert.equal(post(deps, { url: "https://a.com/3" }, { ip: "2.2.2.2" }).status, 201);
});

test("code collisions are retried", () => {
  const codes = ["dup0001", "dup0001", "new0002"];
  const deps = make({ newCode: () => codes.shift()! });
  assert.equal(post(deps, { url: "https://a.com/1" }).status, 201);
  const r = post(deps, { url: "https://a.com/2" });
  assert.equal(r.status, 201);
  assert.equal((r.json as { code: string }).code, "new0002");
});

test("GET /:code redirects, records the click, and 404s for unknown codes", () => {
  const deps = make({ newCode: () => "go12345" });
  post(deps, { url: "https://example.com/target" });
  const hit = handle(req("GET", "/go12345", { referrer: "https://news.site/story?id=1" }), deps);
  assert.equal(hit.status, 302);
  assert.equal(hit.redirect, "https://example.com/target");
  assert.equal(handle(req("GET", "/nope123"), deps).status, 404);
  assert.equal(deps.store.get("go12345")!.clicks, 1);
});

test("stats: totals, 7-day buckets, and top referrers", () => {
  const deps = make({ newCode: () => "st12345" });
  post(deps, { url: "https://example.com" });
  const DAY = 86_400_000;
  handle(req("GET", "/st12345", { referrer: "https://news.site/x", now: T0 }), deps);
  handle(req("GET", "/st12345", { referrer: "https://news.site/y", now: T0 }), deps);
  handle(req("GET", "/st12345", { now: T0 - 2 * DAY }), deps);
  handle(req("GET", "/st12345", { now: T0 - 30 * DAY }), deps); // outside the 7-day window

  const res = handle(req("GET", "/api/links/st12345/stats"), deps);
  assert.equal(res.status, 200);
  const s = res.json as { totalClicks: number; last7Days: { clicks: number }[]; topReferrers: { referrer: string; clicks: number }[] };
  assert.equal(s.totalClicks, 4);
  assert.equal(s.last7Days.length, 7);
  assert.equal(s.last7Days[6].clicks, 2);
  assert.equal(s.last7Days[4].clicks, 1);
  assert.deepEqual(s.topReferrers[0], { referrer: "news.site", clicks: 2 });
  assert.equal(handle(req("GET", "/api/links/missing/stats"), deps).status, 404);
});

test("list omits click history and routes reject wrong methods", () => {
  const deps = make();
  post(deps, { url: "https://a.com" });
  const res = handle(req("GET", "/api/links"), deps);
  const links = (res.json as { links: Record<string, unknown>[] }).links;
  assert.equal(links.length, 1);
  assert.ok(!("recent" in links[0]));
  assert.equal(handle(req("DELETE", "/api/links"), deps).status, 405);
  assert.equal(handle(req("GET", "/api/health"), deps).status, 200);
  assert.equal(handle(req("GET", "/a/b/c"), deps).status, 404);
});

test("store persists to disk (creating folders) and reloads", () => {
  const file = join(mkdtempSync(join(tmpdir(), "sl-")), "nested", "links.json");
  const a = new LinkStore(file);
  a.create("keep123", "https://example.com", T0);
  a.recordClick("keep123", "direct", T0);
  assert.ok(readFileSync(file, "utf8").includes("keep123"));
  const b = new LinkStore(file);
  assert.equal(b.get("keep123")!.clicks, 1);
  assert.equal(b.findByUrl("https://example.com")!.code, "keep123");
});

test("store survives a corrupt data file", () => {
  const dir = mkdtempSync(join(tmpdir(), "sl-"));
  const file = join(dir, "bad.json");
  new LinkStore(file).create("x00000x", "https://a.com");
  writeFileSync(file, "{{{not json");
  assert.equal(new LinkStore(file).list().length, 0);
});
