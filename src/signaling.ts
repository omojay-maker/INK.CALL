import type { Server, Socket } from "socket.io";
import { randomUUID } from "node:crypto";
import {
  canCall,
  createCall,
  endCall,
  getOpenCallByUser,
  getResumableCall,
  markAnswered,
  userBelongsToCall,
  isActiveUser
} from "./db.js";
import {
  callActionSchema,
  candidateSchema,
  descriptionSchema,
  endSchema,
  inviteSchema
} from "./schemas.js";
import type { AuthUser } from "./types.js";
import type { CallRegistry } from "./call-registry.js";

const roomForUser = (id: number) => `user:${id}`;
const ringTimers = new Map<string, NodeJS.Timeout>();
const disconnectTimers = new Map<number, NodeJS.Timeout>();

function ackError(ack: unknown, message: string) {
  if (typeof ack === "function") ack({ ok: false, error: message });
}

async function validateParticipant(callId: string, userId: number, targetUserId: number) {
  return (await userBelongsToCall(callId, userId))
    && (await userBelongsToCall(callId, targetUserId));
}

export function registerSignaling(io: Server, socket: Socket, registry: CallRegistry): void {
  const user = socket.data.user as AuthUser;
  socket.use(async (_event, next) => {
    try {
      if (!(await isActiveUser(user.id))) {
        socket.emit("account:suspended", { redirect: "account-suspended" });
        socket.disconnect(true);
        return next(new Error("account suspended"));
      }
      next();
    } catch {
      next(new Error("account verification failed"));
    }
  });
  clearTimeout(disconnectTimers.get(user.id));
  disconnectTimers.delete(user.id);
  socket.join(roomForUser(user.id));
  socket.emit("call:ready", { userId: user.id });

  socket.on("call:invite", async (raw, ack) => {
    try {
      const input = inviteSchema.parse(raw);
      if (!(await canCall(user.id, input.calleeId))) return ackError(ack, "Call not allowed");
      if (!(await registry.reserve(input.callId, user.id, input.calleeId))) {
        return ackError(ack, "User is busy");
      }

      try {
        await createCall(input.callId, user.id, input.calleeId, input.callType);
      } catch (error) {
        await registry.release(input.callId, user.id, input.calleeId);
        throw error;
      }

      io.to(roomForUser(input.calleeId)).emit("call:incoming", {
        callId: input.callId,
        callType: input.callType,
        caller: user
      });

      ringTimers.set(input.callId, setTimeout(async () => {
        if (!(await registry.is(input.callId, user.id))) return;
        await registry.release(input.callId, user.id, input.calleeId);
        await endCall(input.callId, "missed", user.id);
        io.to(roomForUser(user.id)).emit("call:ended", {
          callId: input.callId,
          reason: "missed"
        });
        io.to(roomForUser(input.calleeId)).emit("call:ended", {
          callId: input.callId,
          reason: "missed"
        });
      }, 45_000));

      if (typeof ack === "function") ack({ ok: true, callId: input.callId });
    } catch {
      ackError(ack, "Invalid call invitation");
    }
  });

  socket.on("call:accept", async (raw, ack) => {
    try {
      const input = callActionSchema.parse(raw);
      if (!(await validateParticipant(input.callId, user.id, input.targetUserId))) {
        return ackError(ack, "Not a call participant");
      }
      clearTimeout(ringTimers.get(input.callId));
      ringTimers.delete(input.callId);
      await markAnswered(input.callId);
      io.to(roomForUser(input.targetUserId)).emit("call:accepted", {
        callId: input.callId,
        by: user.id
      });
      if (typeof ack === "function") ack({ ok: true });
    } catch {
      ackError(ack, "Could not accept call");
    }
  });

  socket.on("call:resume", async (raw, ack) => {
    try {
      const input = callActionSchema.parse(raw);
      const call = await getResumableCall(input.callId, user.id, input.targetUserId);
      if (!call) return ackError(ack, "Call is no longer active");

      if (typeof ack === "function") {
        ack({
          ok: true,
          status: call.status,
          callType: call.callType,
          direction: call.direction,
          peerId: call.peerId,
          answeredAt: call.answeredAt
        });
      }
    } catch {
      ackError(ack, "Could not resume call");
    }
  });

  socket.on("call:resume-ready", async (raw, ack) => {
    try {
      const input = callActionSchema.parse(raw);
      const call = await getResumableCall(input.callId, user.id, input.targetUserId);
      if (!call || call.status !== "active") {
        return ackError(ack, "Call is no longer active");
      }
      io.to(roomForUser(input.targetUserId)).emit("call:peer-resumed", {
        callId: input.callId,
        userId: user.id
      });
      if (typeof ack === "function") ack({ ok: true });
    } catch {
      ackError(ack, "Could not rejoin call");
    }
  });

  socket.on("webrtc:description", async (raw, ack) => {
    try {
      const input = descriptionSchema.parse(raw);
      if (!(await validateParticipant(input.callId, user.id, input.targetUserId))) {
        return ackError(ack, "Not a call participant");
      }
      io.to(roomForUser(input.targetUserId)).emit("webrtc:description", {
        callId: input.callId,
        fromUserId: user.id,
        description: input.description
      });
      if (typeof ack === "function") ack({ ok: true });
    } catch {
      ackError(ack, "Invalid session description");
    }
  });

  socket.on("webrtc:ice-candidate", async (raw) => {
    try {
      const input = candidateSchema.parse(raw);
      if (!(await validateParticipant(input.callId, user.id, input.targetUserId))) return;
      io.to(roomForUser(input.targetUserId)).emit("webrtc:ice-candidate", {
        callId: input.callId,
        fromUserId: user.id,
        candidate: input.candidate
      });
    } catch {
      // Ignore malformed ICE frames without terminating the connection.
    }
  });

  socket.on("call:end", async (raw, ack) => {
    try {
      const input = endSchema.parse(raw);
      if (!(await validateParticipant(input.callId, user.id, input.targetUserId))) {
        return ackError(ack, "Not a call participant");
      }
      clearTimeout(ringTimers.get(input.callId));
      ringTimers.delete(input.callId);
      await registry.release(input.callId, user.id, input.targetUserId);
      await endCall(input.callId, input.reason, user.id);
      io.to(roomForUser(input.targetUserId)).emit("call:ended", {
        callId: input.callId,
        reason: input.reason,
        by: user.id
      });
      if (typeof ack === "function") ack({ ok: true });
    } catch {
      ackError(ack, "Could not end call");
    }
  });

  socket.on("call:heartbeat", (raw) => {
    const parsed = callActionSchema.safeParse(raw);
    if (parsed.success) void registry.is(parsed.data.callId, user.id).then((active) => {
      if (!active) return;
      socket.emit("call:heartbeat:ack", { nonce: randomUUID() });
    });
  });

  socket.on("disconnect", () => {
    void io.in(roomForUser(user.id)).fetchSockets().then((remaining) => {
      if (remaining.length > 0 || disconnectTimers.has(user.id)) return;
      const timer = setTimeout(() => {
        disconnectTimers.delete(user.id);
        void (async () => {
          const sockets = await io.in(roomForUser(user.id)).fetchSockets();
          if (sockets.length > 0) return;
          const callId = await registry.get(user.id);
          if (!callId) return;

          const openCall = await getOpenCallByUser(callId, user.id);
          if (!openCall) {
            await registry.release(callId, user.id);
            return;
          }
          await registry.release(callId, user.id, openCall.peerId);
          await endCall(callId, "failed", user.id);
          io.to(roomForUser(openCall.peerId)).emit("call:ended", {
            callId,
            reason: "failed",
            by: user.id
          });
        })().catch(() => {});
      }, 30_000);
      disconnectTimers.set(user.id, timer);
    });
  });
}
