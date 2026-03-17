// ─────────────────────────────────────────────────────────────────────────────
//  FluxDEX — socketServer.js
//  Socket.io server — pushes live events to all connected frontend clients.
//
//  Events emitted TO clients:
//    "snapshot"      → Pool[]  — full pool list, sent immediately on connect
//    "vault_created" → Pool    — a new vault was deployed via FluxFactory
//    "price_update"  → { poolAddress, currentTick, price, priceLabel, sqrtPriceX96 }
//    "rebalanced"    → { poolAddress, vaultAddress, newTick, oldTokenId, newTokenId, txHash, blockNumber, timestamp }
//
//  No events are received FROM clients in this version (server-push only).
// ─────────────────────────────────────────────────────────────────────────────

import { Server }       from "socket.io";
import { getAllPools }  from "./store.js";
import { setBroadcast } from "./indexer.js";

let io = null;

/**
 * Attaches Socket.io to an existing Express HTTP server.
 * @param {import("http").Server} httpServer
 */
export function attachSocketServer(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: "*",       // allow any frontend origin during development
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket) => {
    console.log(`[Socket.io] Client connected: ${socket.id}  Total: ${io.engine.clientsCount}`);

    // ── Send full snapshot immediately on connect ─────────────────────────
    // Frontend can render the pool list without waiting for the next poll.
    socket.emit("snapshot", _serializePools(getAllPools()));

    socket.on("disconnect", (reason) => {
      console.log(`[Socket.io] Client disconnected: ${socket.id}  Reason: ${reason}`);
    });

    socket.on("error", (err) => {
      console.warn(`[Socket.io] Client error (${socket.id}):`, err.message);
    });
  });

  // ── Register broadcast function with the indexer ──────────────────────────
  // The indexer calls broadcast({ type, data }) whenever an event fires.
  // We map each type to a named Socket.io event for clean frontend handling.
  setBroadcast(({ type, data }) => {
    if (!io) return;

    // Serialize BigInts before emitting
    const payload = _serialize(data);

    // Emit as a named event — frontend does socket.on("rebalanced", handler)
    // instead of parsing a generic "message" event type field.
    io.emit(type, payload);

    console.log(`[Socket.io] Broadcast → ${type}  clients: ${io.engine.clientsCount}`);
  });

  console.log("[Socket.io] Server attached.");
}

// ─────────────────────────────────────────────────────────────────────────────
//  INTERNAL
// ─────────────────────────────────────────────────────────────────────────────

// Socket.io serializes via JSON.stringify internally.
// BigInts cause a TypeError — convert them to strings first.
function _serialize(data) {
  return JSON.parse(JSON.stringify(data, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value
  ));
}

function _serializePools(pools) {
  return _serialize(pools);
}
