import Fastify from "fastify";
import type { FastifyReply, FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";
import { config } from "./config.js";
import { db } from "./db.js";
import { socketAuth, verifyCallToken } from "./auth.js";
import { createTurnCredentials, getTurnConfigurationMode } from "./turn.js";
import { registerSignaling } from "./signaling.js";
import { CallRegistry } from "./call-registry.js";

const app = Fastify({ logger: true, trustProxy: true });
await app.register(helmet);
await app.register(cors, {
  origin: config.APP_ORIGIN.split(",").map((value) => value.trim()),
  credentials: true
});
await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });

app.get("/", async () => ({
  service: "INK Call",
  status: "online",
  message: "Realtime calling is ready. Open calls from the INK app.",
  app: config.APP_ORIGIN.split(",")[0]?.trim(),
  health: "/health/ready"
}));
app.get("/health/live", async () => ({ status: "ok", turn: getTurnConfigurationMode() }));
app.get("/health/ready", async (_request, reply) => {
  try {
    await db.query("SELECT 1");
    return { status: "ready", turn: getTurnConfigurationMode() };
  } catch {
    return reply.code(503).send({ status: "not_ready" });
  }
});

app.post("/internal/admin/probe", async (request, reply) => {
  if (request.headers["x-ink-admin-secret"] !== config.ADMIN_SERVICE_SECRET) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
  try {
    await db.query("SELECT 1");
    return { status: "ready", signaling: "accepting_connections" };
  } catch {
    return reply.code(503).send({ error: "Database unavailable" });
  }
});

// TURN is recommended but not mandatory to boot: without it the service runs
// on STUN-only, which still works for most peers (calls behind strict NATs may
// fail). Provision a Coturn server and set TURN_URL / TURN_TLS_URL /
// TURN_SHARED_SECRET for reliable connectivity.
if (
  config.NODE_ENV === "production" &&
  (!config.TURN_URL ||
    (!(config.TURN_USERNAME && config.TURN_CREDENTIAL) && !config.TURN_SHARED_SECRET))
) {
  app.log.warn(
    "TURN server not configured - calls may fail behind strict NATs. Configure static credentials or a shared secret."
  );
}

const iceServerHandler = async (request: FastifyRequest, reply: FastifyReply) => {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
  try {
    const user = await verifyCallToken(header.slice(7));
    return createTurnCredentials(user.id);
  } catch {
    return reply.code(401).send({ error: "Unauthorized" });
  }
};
app.get("/v1/ice-servers", iceServerHandler);
app.get("/api/v1/ice-servers", iceServerHandler);

const io = new Server(app.server, {
  path: "/socket.io",
  cors: {
    origin: config.APP_ORIGIN.split(",").map((value) => value.trim()),
    credentials: true
  },
  transports: ["websocket"],
  maxHttpBufferSize: 1_000_000,
  pingInterval: 25_000,
  pingTimeout: 20_000
});

let registry: CallRegistry;
if (config.REDIS_URL) {
  const pubClient = createClient({
    url: config.REDIS_URL,
    socket: {
      connectTimeout: 3_000,
      reconnectStrategy: config.NODE_ENV === "production" ? undefined : false
    }
  });
  const subClient = pubClient.duplicate();
  try {
    await Promise.all([pubClient.connect(), subClient.connect()]);
    io.adapter(createAdapter(pubClient, subClient));
    registry = new CallRegistry(pubClient);
  } catch (error) {
    await Promise.allSettled([pubClient.close(), subClient.close()]);
    if (config.NODE_ENV === "production") throw error;
    app.log.warn({ error }, "Redis unavailable; using the in-process call registry");
    registry = new CallRegistry();
  }
} else {
  registry = new CallRegistry();
}

io.use((socket, next) => void socketAuth(socket, (error) => {
  if (error) {
    app.log.warn({ socketId: socket.id, address: socket.handshake.address }, "call socket authentication failed");
  }
  next(error);
}));
io.on("connection", (socket) => registerSignaling(io, socket, registry));

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  io.close();
  await db.end();
  await app.close();
  process.exit(0);
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.ready();
await app.listen({ port: config.PORT, host: config.HOST });
