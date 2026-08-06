import { z } from "zod";

export const inviteSchema = z.object({
  callId: z.string().uuid(),
  calleeId: z.number().int().positive(),
  callType: z.enum(["audio", "video"])
});

export const callActionSchema = z.object({
  callId: z.string().uuid(),
  targetUserId: z.number().int().positive()
});

export const endSchema = callActionSchema.extend({
  reason: z.enum(["completed", "declined", "cancelled", "missed", "busy", "failed"])
});

export const descriptionSchema = callActionSchema.extend({
  description: z.object({
    type: z.enum(["offer", "answer"]),
    sdp: z.string().min(1).max(1_000_000)
  })
});

export const candidateSchema = callActionSchema.extend({
  candidate: z.object({
    candidate: z.string().max(8192),
    sdpMid: z.string().nullable(),
    sdpMLineIndex: z.number().int().nullable(),
    usernameFragment: z.string().nullable().optional()
  })
});
