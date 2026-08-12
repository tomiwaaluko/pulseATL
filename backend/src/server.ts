import express, { Express } from "express";
import path from "path";

import { getAllReports, initSchema } from "./db";
import { npusRouter } from "./routes/npus";
import { compareRouter } from "./routes/compare";
import { chatRouter } from "./routes/chat";

function errorStatus(err: unknown): number {
  if (typeof err === "object" && err !== null) {
    const candidate =
      (err as { status?: unknown; statusCode?: unknown }).status ??
      (err as { statusCode?: unknown }).statusCode;
    if (typeof candidate === "number" && candidate >= 400 && candidate < 600) {
      return candidate;
    }
  }
  return 500;
}

export function createApp(): Express {
  const app = express();
  app.use(express.json());

  app.use("/api/npus", npusRouter);
  app.use("/api/compare", compareRouter);
  app.use("/api/chat", chatRouter);

  app.get("/api/health", async (_req, res) => {
    try {
      const reports = await getAllReports();
      const last_ingest = reports.reduce<string | null>((latest, report) => {
        const updated =
          report.updated_at instanceof Date
            ? report.updated_at.toISOString()
            : (report.updated_at as unknown as string);
        return latest === null || updated > latest ? updated : latest;
      }, null);
      res.status(200).json({ ok: true, last_ingest, row_count: reports.length });
    } catch {
      res.status(200).json({ ok: false, last_ingest: null, row_count: 0 });
    }
  });

  const frontendDist = path.join(__dirname, "../../frontend/dist");
  app.use(express.static(frontendDist));

  app.get(/^\/(?!api).*/, (_req, res) => {
    res.sendFile(path.join(frontendDist, "index.html"));
  });

  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    console.error(err);
    res.status(errorStatus(err)).json({ detail: "internal server error" });
  });

  return app;
}

if (require.main === module) {
  const app = createApp();
  const port = Number(process.env.PORT) || 3000;
  initSchema()
    .catch((err: unknown) => {
      console.error("Failed to initialize schema on boot", err);
    })
    .finally(() => {
      app.listen(port, () => {
        console.log(`Pulse ATL backend listening on port ${port}`);
      });
    });
}
