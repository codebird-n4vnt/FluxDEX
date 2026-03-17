// ─────────────────────────────────────────────────────────────────────────────
//  FluxDEX — socket.js
//  Socket.io client singleton.
//
//  Why a singleton:
//    React components mount/unmount frequently. If each component created its
//    own socket connection, we'd open dozens of connections to the backend.
//    A singleton ensures exactly one connection exists for the entire app.
//
//  Usage:
//    import socket from "@/lib/socket";
//
//    // Listen for events
//    socket.on("snapshot",     (pools)   => { ... });
//    socket.on("price_update", (data)    => { ... });
//    socket.on("rebalanced",   (data)    => { ... });
//    socket.on("vault_created",(pool)    => { ... });
//
//    // Check connection state
//    socket.connected  // boolean
//
//    // Clean up a specific listener (always do this in useEffect cleanup)
//    socket.off("rebalanced", myHandler);
//
//  Events received from backend (matching socketServer.js exactly):
//    "snapshot"      → Pool[]
//    "vault_created" → Pool
//    "price_update"  → { poolAddress, currentTick, price, priceLabel, sqrtPriceX96 }
//    "rebalanced"    → { poolAddress, vaultAddress, newTick, oldTokenId,
//                        newTokenId, txHash, blockNumber, timestamp }
//
//  Connection lifecycle:
//    • Socket connects automatically when this module is first imported.
//    • It reconnects automatically if the backend restarts (Socket.io default).
//    • Connection state is exposed via socket.connected.
//    • Listen to "connect" / "disconnect" events for UI status indicators.
// ─────────────────────────────────────────────────────────────────────────────

import { io } from "socket.io-client";

// ── Backend URL ───────────────────────────────────────────────────────────────
// Reads from Vite env variable at build time.
// In development: set VITE_BACKEND_URL=http://localhost:3001 in .env
// In production:  set VITE_BACKEND_URL=https://your-backend.com
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:3001";

// ── Create the singleton socket ───────────────────────────────────────────────
const socket = io(BACKEND_URL, {
  // autoConnect: true means the socket connects immediately on import.
  // Set to false if you want to delay connection until wallet is connected.
  autoConnect: true,

  // Reconnection strategy — explicit defaults for clarity.
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000, // wait 1s before first retry
  reconnectionDelayMax: 5000, // cap retry wait at 5s

  // Start with websocket, fall back to polling if needed.
  transports: ["websocket", "polling"],
});

// ── Development logging ───────────────────────────────────────────────────────
// Stripped from production builds by Vite (import.meta.env.DEV = false).
if (import.meta.env.DEV) {
  socket.on("connect", () => {
    console.log("[Socket.io] Connected:", socket.id);
  });

  socket.on("disconnect", (reason) => {
    console.log("[Socket.io] Disconnected:", reason);
  });

  socket.on("connect_error", (err) => {
    console.warn("[Socket.io] Connection error:", err.message);
  });

  socket.on("reconnect_attempt", (attempt) => {
    console.log(`[Socket.io] Reconnect attempt #${attempt}`);
  });

  socket.on("reconnect", (attempt) => {
    console.log(`[Socket.io] Reconnected after ${attempt} attempt(s)`);
  });

  // Log every incoming event so you can see exactly what the backend sends
  socket.onAny((eventName, data) => {
    // Truncate snapshot logs — they contain the full pool list which is huge
    if (eventName === "snapshot") {
      console.log(`[Socket.io] ← snapshot  (${data?.length ?? 0} pools)`);
    } else {
      console.log(`[Socket.io] ← ${eventName}`, data);
    }
  });
}

export default socket;
