import express, { Express } from "express";
import path from "path";

export function createApp(): Express {
  const app = express();
  app.use(express.json());

  const frontendDist = path.join(__dirname, "../../frontend/dist");
  app.use(express.static(frontendDist));

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  return app;
}

if (require.main === module) {
  const app = createApp();
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`Pulse ATL backend listening on port ${port}`);
  });
}
