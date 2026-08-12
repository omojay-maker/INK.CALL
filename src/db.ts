import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";
import { readFileSync } from "node:fs";
import { config } from "./config.js";

export const db: Pool = mysql.createPool({
  host: config.DB_HOST,
  port: config.DB_PORT,
  database: config.DB_NAME,
  user: config.DB_USER,
  password: config.DB_PASSWORD,
  connectionLimit: config.DB_POOL_SIZE,
  enableKeepAlive: true,
  charset: "utf8mb4",
  ssl: config.DB_SSL_CA ? {
    ca: readFileSync(config.DB_SSL_CA, "utf8"),
    rejectUnauthorized: config.DB_SSL_VERIFY
  } : undefined
});

export async function isActiveUser(userId: number): Promise<boolean> {
  if (userId <= 0) return false;
  const [rows] = await db.execute<RowDataPacket[]>(
    "SELECT 1 FROM users WHERE UID = ? AND account_status = 'active' LIMIT 1",
    [userId]
  );
  return rows.length === 1;
}

export async function canCall(userId: number, peerId: number): Promise<boolean> {
  if (userId <= 0 || peerId <= 0 || userId === peerId) return false;
  if (!(await isActiveUser(userId)) || !(await isActiveUser(peerId))) return false;

  const [rows] = await db.execute<RowDataPacket[]>(
    `SELECT
       EXISTS(
         SELECT 1 FROM friendships
         WHERE ((user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?))
           AND host_status = 'accepted'
           AND friend_status = 'accepted'
       ) AS are_friends,
       EXISTS(
         SELECT 1 FROM blocks
         WHERE (blocker_id = ? AND blocked_id = ?)
            OR (blocker_id = ? AND blocked_id = ?)
       ) AS is_blocked`,
    [userId, peerId, peerId, userId, userId, peerId, peerId, userId]
  );

  return Number(rows[0]?.are_friends) === 1 && Number(rows[0]?.is_blocked) === 0;
}

export async function createCall(
  callId: string,
  callerId: number,
  calleeId: number,
  callType: "audio" | "video"
): Promise<void> {
  await db.execute(
    `INSERT INTO rtc_calls
       (call_id, caller_id, callee_id, call_type, status, initiated_at)
     VALUES (?, ?, ?, ?, 'ringing', NOW())`,
    [callId, callerId, calleeId, callType]
  );
}

export async function markAnswered(callId: string): Promise<void> {
  await db.execute(
    `UPDATE rtc_calls
     SET status = 'active', answered_at = COALESCE(answered_at, NOW())
     WHERE call_id = ? AND status = 'ringing'`,
    [callId]
  );
}

export async function endCall(
  callId: string,
  reason: string,
  actorId: number
): Promise<void> {
  await db.execute(
    `UPDATE rtc_calls
     SET status = ?, ended_by = ?, ended_at = COALESCE(ended_at, NOW()),
         duration_seconds = CASE
           WHEN answered_at IS NULL THEN 0
           ELSE TIMESTAMPDIFF(SECOND, answered_at, COALESCE(ended_at, NOW()))
         END
     WHERE call_id = ? AND ended_at IS NULL`,
    [reason, actorId, callId]
  );
}

export async function userBelongsToCall(callId: string, userId: number): Promise<boolean> {
  const [rows] = await db.execute<RowDataPacket[]>(
    `SELECT 1 FROM rtc_calls
     WHERE call_id = ? AND (caller_id = ? OR callee_id = ?)
     LIMIT 1`,
    [callId, userId, userId]
  );
  return rows.length === 1;
}

export async function createMissedCallNotification(
  callerId: number,
  calleeId: number,
  callerName: string,
  callType: "audio" | "video"
): Promise<void> {
  const label = callType === "video" ? "video" : "voice";
  await db.execute(
    `INSERT INTO notifications (user_id, actor_id, type, message, link)
     VALUES (?, ?, 'missed_call', ?, ?)`,
    [calleeId, callerId, `Missed ${label} call from ${callerName}`, `chat?id=${callerId}`]
  );
}

export async function getResumableCall(
  callId: string,
  userId: number,
  targetUserId: number
): Promise<{
  status: "ringing" | "active";
  callType: "audio" | "video";
  direction: "incoming" | "outgoing";
  peerId: number;
  answeredAt: Date | string | null;
} | null> {
  const [rows] = await db.execute<RowDataPacket[]>(
    `SELECT status, call_type, caller_id, callee_id, answered_at
     FROM rtc_calls
     WHERE call_id = ?
       AND ((caller_id = ? AND callee_id = ?) OR (caller_id = ? AND callee_id = ?))
       AND status IN ('ringing', 'active')
       AND ended_at IS NULL
     LIMIT 1`,
    [callId, userId, targetUserId, targetUserId, userId]
  );
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  return {
    status: row.status as "ringing" | "active",
    callType: row.call_type as "audio" | "video",
    direction: Number(row.caller_id) === userId ? "outgoing" : "incoming",
    peerId: Number(row.caller_id) === userId ? Number(row.callee_id) : Number(row.caller_id),
    answeredAt: (row.answered_at as Date | string | null) ?? null
  };
}

export async function getOpenCallByUser(
  callId: string,
  userId: number
): Promise<{ peerId: number } | null> {
  const [rows] = await db.execute<RowDataPacket[]>(
    `SELECT caller_id, callee_id
     FROM rtc_calls
     WHERE call_id = ?
       AND (caller_id = ? OR callee_id = ?)
       AND status IN ('ringing', 'active')
       AND ended_at IS NULL
     LIMIT 1`,
    [callId, userId, userId]
  );
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  return {
    peerId: Number(row.caller_id) === userId ? Number(row.callee_id) : Number(row.caller_id)
  };
}

export async function getPendingIncomingCall(userId: number): Promise<{
  callId: string;
  callType: "audio" | "video";
  caller: { id: number; name: string; avatar?: string };
} | null> {
  const [rows] = await db.execute<RowDataPacket[]>(
    `SELECT c.call_id, c.call_type, c.caller_id,
            COALESCE(NULLIF(u.full_name, ''), u.username, CONCAT('User ', u.UID)) AS caller_name,
            u.profile_picture
     FROM rtc_calls c
     JOIN users u ON u.UID = c.caller_id
     WHERE c.callee_id = ?
       AND c.status = 'ringing'
       AND c.ended_at IS NULL
       AND c.initiated_at >= NOW() - INTERVAL 45 SECOND
     ORDER BY c.initiated_at DESC
     LIMIT 1`,
    [userId]
  );
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  return {
    callId: String(row.call_id),
    callType: row.call_type as "audio" | "video",
    caller: {
      id: Number(row.caller_id),
      name: String(row.caller_name),
      avatar: row.profile_picture ? String(row.profile_picture) : undefined
    }
  };
}
