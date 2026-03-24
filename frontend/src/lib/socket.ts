// ─────────────────────────────────────────────────────────────────────────────
//  FluxDEX — socket.ts
//  Socket.io client singleton with strict TypeScript typing.
// ─────────────────────────────────────────────────────────────────────────────

import { io, Socket } from "socket.io-client";
import type { Pool, LiveData, RebalanceEvent } from "../types";

// ── Strict Event Typing ───────────────────────────────────────────────────────
// This gives your IDE perfect intellisense anywhere you call socket.on()

export interface ServerToClientEvents {
  snapshot: (pools: Pool[]) => void;
  vault_created: (pool: Pool) => void;
  price_update: (data: LiveData & { poolAddress: string }) => void;
  rebalanced: (data: RebalanceEvent & { poolAddress: string }) => void;
}

export interface ClientToServerEvents {
  // Add any client-to-server emissions here if you ever need them
}

// ── Backend URL ───────────────────────────────────────────────────────────────
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:3001";

// ── Create the singleton socket ───────────────────────────────────────────────
const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(BACKEND_URL, {
  autoConnect: true,
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000, 
  reconnectionDelayMax: 5000, 
  transports: ["websocket", "polling"],
});

// ── Development logging ───────────────────────────────────────────────────────
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

  // @ts-ignore - Socket.io types for built-in reconnect events are sometimes tricky to extend
  socket.io.on("reconnect_attempt", (attempt: number) => {
    console.log(`[Socket.io] Reconnect attempt #${attempt}`);
  });

  // @ts-ignore
  socket.io.on("reconnect", (attempt: number) => {
    console.log(`[Socket.io] Reconnected after ${attempt} attempt(s)`);
  });

  // Log every incoming event
  socket.onAny((eventName: string, data: any) => {
    if (eventName === "snapshot") {
      console.log(`[Socket.io] ← snapshot  (${data?.length ?? 0} pools)`);
    } else {
      console.log(`[Socket.io] ← ${eventName}`, data);
    }
  });
}

export default socket;