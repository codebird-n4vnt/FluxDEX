// ─────────────────────────────────────────────────────────────────────────────
//  FluxDEX — wsServer.js
//  WebSocket server for pushing live events to connected frontend clients.
//
//  Message types pushed to clients:
//    { type: "vault_created",  data: Pool }
//    { type: "rebalanced",     data: { poolAddress, vaultAddress, newTick, ... } }
//    { type: "price_update",   data: { poolAddress, currentTick, price, priceLabel } }
//    { type: "snapshot",       data: Pool[] }  ← sent on first connect
// ─────────────────────────────────────────────────────────────────────────────

import { WebSocketServer } from "ws";
import { getAllPools }      from "./store.js";
import { setBroadcast }    from "./indexer.js";

let wss = null;

/**
 * Attaches a WebSocket server to an existing HTTP server.
 * @param {import("http").Server} httpServer
 */
export function attachWebSocketServer(httpServer) {
  wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws) => {
    console.log("[WS] Client connected. Total:", wss.clients.size);

    // Send a snapshot of all current pool data immediately on connect
    _send(ws, {
      type: "snapshot",
      data: getAllPools(),
    });

    ws.on("close", () => {
      console.log("[WS] Client disconnected. Total:", wss.clients.size);
    });

    ws.on("error", (err) => {
      console.warn("[WS] Client error:", err.message);
    });
  });

  // Register the broadcast function with the indexer
  // so it can push events to all connected clients
  setBroadcast(_broadcast);

  console.log("[WS] WebSocket server attached.");
}

// ─────────────────────────────────────────────────────────────────────────────
//  INTERNAL
// ─────────────────────────────────────────────────────────────────────────────

function _broadcast(message) {
  if (!wss) return;
  const payload = JSON.stringify(message, _bigintReplacer);
  for (const client of wss.clients) {
    if (client.readyState === 1) { // OPEN
      client.send(payload);
    }
  }
}

function _send(ws, message) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(message, _bigintReplacer));
  }
}

// JSON.stringify can't handle BigInt — convert to string
function _bigintReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}
