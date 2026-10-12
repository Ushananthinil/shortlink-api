import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Click {
  at: number;
  referrer: string;
}

export interface Link {
  code: string;
  url: string;
  createdAt: number;
  clicks: number;
  recent: Click[]; // capped, for analytics
}

export interface Stats {
  code: string;
  url: string;
  totalClicks: number;
  createdAt: number;
  lastClickAt: number | null;
  last7Days: { date: string; clicks: number }[];
  topReferrers: { referrer: string; clicks: number }[];
}

const MAX_RECENT = 1000;
const DAY = 86_400_000;
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

export class LinkStore {
  private links = new Map<string, Link>();
  private byUrl = new Map<string, string>();

  constructor(private file?: string) {
    if (file && existsSync(file)) {
      try {
        const data = JSON.parse(readFileSync(file, "utf8")) as Link[];
        for (const l of data) this.index(l);
      } catch {
        /* corrupt file: start empty rather than crash */
      }
    }
  }

  private index(l: Link) {
    this.links.set(l.code, l);
    this.byUrl.set(l.url, l.code);
  }

  private persist() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.links.values()]));
    renameSync(tmp, this.file); // atomic replace, so a crash can't leave a half-written file
  }

  has(code: string) { return this.links.has(code); }
  get(code: string) { return this.links.get(code); }
  findByUrl(url: string) { const c = this.byUrl.get(url); return c ? this.links.get(c) : undefined; }

  create(code: string, url: string, now = Date.now()): Link {
    const link: Link = { code, url, createdAt: now, clicks: 0, recent: [] };
    this.index(link);
    this.persist();
    return link;
  }

  list(limit = 50): Link[] {
    return [...this.links.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  recordClick(code: string, referrer: string, now = Date.now()) {
    const l = this.links.get(code);
    if (!l) return;
    l.clicks++;
    l.recent.push({ at: now, referrer });
    if (l.recent.length > MAX_RECENT) l.recent.shift();
    this.persist();
  }

  stats(code: string, now = Date.now()): Stats | undefined {
    const l = this.links.get(code);
    if (!l) return undefined;
    const days = Array.from({ length: 7 }, (_, i) => day(now - (6 - i) * DAY));
    const counts = new Map(days.map((d) => [d, 0]));
    const refs = new Map<string, number>();
    for (const c of l.recent) {
      const d = day(c.at);
      if (counts.has(d)) counts.set(d, counts.get(d)! + 1);
      refs.set(c.referrer, (refs.get(c.referrer) ?? 0) + 1);
    }
    return {
      code: l.code, url: l.url, totalClicks: l.clicks, createdAt: l.createdAt,
      lastClickAt: l.recent.length ? l.recent[l.recent.length - 1].at : null,
      last7Days: days.map((d) => ({ date: d, clicks: counts.get(d)! })),
      topReferrers: [...refs].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([referrer, clicks]) => ({ referrer, clicks })),
    };
  }
}
