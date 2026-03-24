// ─────────────────────────────────────────────────────────────────────────────
//  FluxDEX — index.js
//  Backend entry point. Boots Express + Socket.io, starts the indexer.
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import http    from "http";
import express from "express";
import cors    from "cors";

import { router }                from "./api.js";
import { attachSocketServer }    from "./socketServer.js";
import { startIndexer }          from "./indexer.js";
import { loadUniswapTokenList }  from "./tokenMetadata.js";

const PORT = process.env.PORT ?? 3001;

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();

app.use(cors());
app.use(express.json());

// REST routes under /api
app.use("/api", router);

// ── HTTP server (shared between Express and Socket.io) ────────────────────────
const httpServer = http.createServer(app);

// Attach Socket.io to the same HTTP server
attachSocketServer(httpServer);

// ── Boot sequence ─────────────────────────────────────────────────────────────
async function boot() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║       FluxDEX Backend Indexer        ║");
  console.log("║       Somnia Testnet  (50312)        ║");
  console.log("╚══════════════════════════════════════╝\n");

  console.log("[Boot] Config:");
  console.log(`  FACTORY_ADDRESS .... ${process.env.FACTORY_ADDRESS ?? "NOT SET"}`);
  console.log(`  RPC_URL ........... ${process.env.RPC_URL ?? "(default)"}`);
  console.log(`  WSS_URL ........... ${process.env.WSS_URL ?? "(default)"}`);
  console.log(`  PORT .............. ${PORT}`);
  console.log(`  POLL_INTERVAL ..... ${process.env.POLL_INTERVAL_MS ?? 5000}ms\n`);

  // 1. Load Uniswap token list so metadata is ready before indexer starts
  try {
    await loadUniswapTokenList();
  } catch (err) {
    console.warn("[Boot] Token list load failed (non-fatal):", err.message);
  }

  // 2. Start HTTP server FIRST so frontend can connect immediately
  //    (indexer historical sync can take minutes on slow RPCs)
  httpServer.listen(PORT, () => {
    console.log(`\n[Server] REST API  → http://localhost:${PORT}/api`);
    console.log(`[Server] Socket.io → ws://localhost:${PORT}`);
    console.log(`[Server] Health    → http://localhost:${PORT}/api/health\n`);
  });

  // 3. Start indexer in the background — historical sync, live WSS subs, polling
  //    This runs asynchronously; the API will serve empty results until sync finishes.
  startIndexer().catch((err) => {
    console.error("[Boot] Indexer start failed:", err.message);
    console.error("[Boot] Backend will still serve API but with no indexed data.");
  });
}

boot().catch((err) => {
  console.error("[FATAL] Boot failed:", err);
  process.exit(1);
});
