import { createHmac } from "node:crypto";
import { config } from "./config.js";

export function createTurnCredentials(userId: number) {
  const expiresAt = Math.floor(Date.now() / 1000) + config.TURN_TTL_SECONDS;
  const iceServers: Array<{
    urls: string[];
    username?: string;
    credential?: string;
  }> = [{ urls: [config.STUN_URL] }];

  // Local development can use STUN-only. A relay remains mandatory in
  // production because many NAT/firewall combinations cannot connect P2P.
  const hasStaticTurn = Boolean(
    config.TURN_URL &&
    config.TURN_USERNAME &&
    config.TURN_CREDENTIAL &&
    !/example\.com|replace-me|replace-with/i.test(
      config.TURN_URL + config.TURN_USERNAME + config.TURN_CREDENTIAL
    )
  );
  const hasSharedSecretTurn = Boolean(
    config.TURN_URL &&
    config.TURN_SHARED_SECRET &&
    config.TURN_SHARED_SECRET.length >= 32 &&
    !/example\.com|replace-me|replace-with/i.test(config.TURN_URL + config.TURN_SHARED_SECRET)
  );
  if (!hasStaticTurn && !hasSharedSecretTurn) {
    return { expiresAt, iceServers };
  }

  const urls = [config.TURN_URL!];
  if (config.TURN_TLS_URL) urls.push(config.TURN_TLS_URL);

  if (hasStaticTurn) {
    return {
      expiresAt,
      iceServers: [
        ...iceServers,
        { urls, username: config.TURN_USERNAME!, credential: config.TURN_CREDENTIAL! }
      ]
    };
  }

  const username = `${expiresAt}:${userId}`;
  const credential = createHmac("sha1", config.TURN_SHARED_SECRET!)
    .update(username)
    .digest("base64");

  return {
    expiresAt,
    iceServers: [...iceServers, { urls, username, credential }]
  };
}
