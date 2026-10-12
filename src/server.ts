import express, { NextFunction, Request, Response } from "express";
import { RateLimiter } from "./ratelimit.js";
import { handle } from "./router.js";
import { LinkStore } from "./store.js";

const app = express();
const store = new LinkStore(process.env.DATA_FILE ?? "data/links.json");
const limiter = new RateLimiter(20, 60_000); // 20 creations per minute per IP
setInterval(() => limiter.prune(), 5 * 60_000).unref();

app.set("trust proxy", process.env.TRUST_PROXY === "1"); // set behind Cloud Run / a load balancer
app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));

app.use((req: Request, res: Response) => {
  const out = handle(
    {
      method: req.method,
      path: req.path,
      body: req.body,
      ip: req.ip ?? "unknown",
      referrer: req.get("referer") ?? undefined,
      now: Date.now(),
      baseUrl: process.env.BASE_URL ?? `${req.protocol}://${req.get("host")}`,
    },
    { store, limiter },
  );
  for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
  if (out.redirect) return void res.redirect(302, out.redirect);
  res.status(out.status).json(out.json);
});

// Malformed JSON and other errors
app.use((e: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  if (e.status === 400 || e instanceof SyntaxError) return void res.status(400).json({ error: "Request body must be valid JSON." });
  console.error(e);
  res.status(500).json({ error: "Something went wrong on the server." });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`ShortLink API on http://localhost:${port}`));
