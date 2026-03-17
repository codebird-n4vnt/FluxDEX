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

  // 1. Load Uniswap token list so metadata is ready before indexer starts
  await loadUniswapTokenList();

  // 2. Start indexer — historical sync, live WSS subs, polling loop
  await startIndexer();

  // 3. Start listening
  httpServer.listen(PORT, () => {
    console.log(`\n[Server] REST API  → http://localhost:${PORT}/api`);
    console.log(`[Server] Socket.io → ws://localhost:${PORT}`);
    console.log(`[Server] Health    → http://localhost:${PORT}/api/health\n`);
  });
}

boot().catch((err) => {
  console.error("[FATAL] Boot failed:", err);
  process.exit(1);
});
