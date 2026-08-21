import crypto from "crypto";
import { Router } from "express";

import { defaultDeps, runIngest } from "../ingest/run";
import { redactSecrets } from "../redact";

/** Ingest runs take minutes; the route responds early rather than holding the connection open. */
const RESPONSE_DEADLINE_MS = 20_000;

let running = false;

function timingSafeTokenMatch(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

interface IngestSuccessPayload {
  ok: true;
  /** True when `?snowflake=off` ran the local-aggregation path; Cortex findings carry the unavailable marker. */
  snowflake_skipped: boolean;
  reports_written: number;
  normalized: number;
  rejected: number;
  duration_ms: number;
}

interface IngestFailurePayload {
  ok: false;
  error: string;
}

export const adminRouter = Router();

adminRouter.get("/ingest", (req, res) => {
  const expected = process.env.INGEST_TOKEN;
  if (!expected) {
    res.status(404).end();
    return;
  }

  const provided = typeof req.query.token === "string" ? req.query.token : "";
  if (!timingSafeTokenMatch(provided, expected)) {
    res.status(401).json({ detail: "unauthorized" });
    return;
  }

  if (running) {
    res.status(409).json({ detail: "ingest already running" });
    return;
  }

  // `?snowflake=off` selects the --no-snowflake path: incidents are aggregated
  // locally in TypeScript and Cortex is never called. It exists because the
  // deployed service is the only host that can reach Postgres, so when its
  // Snowflake credentials are the broken part there is otherwise no way to
  // populate the cache at all.
  const noSnowflake = req.query.snowflake === "off";

  running = true;
  const startedAt = Date.now();
  console.log(`[admin-ingest] starting seed ingest${noSnowflake ? " (snowflake skipped)" : ""}`);

  const result: Promise<IngestSuccessPayload | IngestFailurePayload> = runIngest(defaultDeps(), {
    seed: true,
    noSnowflake,
  }).then(
    (summary) => {
      const normalized = summary.sources.reduce((sum, source) => sum + source.normalized, 0);
      const rejected = summary.sources.reduce((sum, source) => sum + source.rejected, 0);
      const payload: IngestSuccessPayload = {
        ok: true,
        snowflake_skipped: noSnowflake,
        reports_written: summary.npusReported,
        normalized,
        rejected,
        duration_ms: Date.now() - startedAt,
      };
      console.log(`[admin-ingest] done: ${JSON.stringify(payload)}`);
      return payload;
    },
    (error: unknown) => {
      const message = redactSecrets(error instanceof Error ? error.message : String(error));
      console.error(`[admin-ingest] failed: ${message}`);
      return { ok: false, error: message } satisfies IngestFailurePayload;
    },
  );
  result.finally(() => {
    running = false;
  });

  result.then((payload) => {
    if (res.headersSent) return;
    res.status(payload.ok ? 200 : 500).json(payload);
  });

  setTimeout(() => {
    if (res.headersSent) return;
    res.status(202).json({ ok: true, started: true, snowflake_skipped: noSnowflake });
  }, RESPONSE_DEADLINE_MS);
});
