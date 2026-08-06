import { jwtVerify } from "jose";
import type { Socket } from "socket.io";
import { config } from "./config.js";
import type { AuthUser } from "./types.js";
import { isActiveUser } from "./db.js";

const secret = new TextEncoder().encode(config.CALL_JWT_SECRET);

export async function verifyCallToken(token: string): Promise<AuthUser> {
  const { payload } = await jwtVerify(token, secret, {
    algorithms: ["HS256"],
    issuer: config.CALL_JWT_ISSUER,
    audience: config.CALL_JWT_AUDIENCE
  });

  const id = Number(payload.sub);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid token subject");
  if (!(await isActiveUser(id))) throw new Error("Account is not active");

  return {
    id,
    name: typeof payload.name === "string" ? payload.name : `User ${id}`,
    avatar: typeof payload.avatar === "string" ? payload.avatar : undefined
  };
}

export async function socketAuth(socket: Socket, next: (error?: Error) => void): Promise<void> {
  try {
    const token = socket.handshake.auth.token;
    if (typeof token !== "string" || token.length > 4096) throw new Error("Missing token");
    socket.data.user = await verifyCallToken(token);
    next();
  } catch {
    next(new Error("unauthorized"));
  }
}
