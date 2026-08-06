export type CallType = "audio" | "video";
export type CallEndReason =
  | "completed"
  | "declined"
  | "cancelled"
  | "missed"
  | "busy"
  | "failed";

export interface AuthUser {
  id: number;
  name: string;
  avatar?: string;
}

export interface CallInvite {
  callId: string;
  calleeId: number;
  callType: CallType;
}

export interface SessionDescriptionPayload {
  callId: string;
  targetUserId: number;
  description: {
    type: "offer" | "answer";
    sdp: string;
  };
}

export interface IceCandidatePayload {
  callId: string;
  targetUserId: number;
  candidate: {
    candidate: string;
    sdpMid: string | null;
    sdpMLineIndex: number | null;
    usernameFragment?: string | null;
  };
}
