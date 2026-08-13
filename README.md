# INK Call Service

Standalone one-to-one voice/video calling for INK. The service replaces Agora
with browser WebRTC, Socket.IO signalling, Redis fan-out and self-hosted Coturn.

## Responsibility boundaries

| Component | Responsibility |
|---|---|
| INK PHP app | Login session, user profile, call buttons and overlay |
| Call service | Token verification, authorization, ringing, SDP/ICE signalling and call state |
| Browser WebRTC | Encrypted peer-to-peer audio/video |
| Coturn | Relays media when direct peer-to-peer connectivity fails |
| Redis | Routes signalling when multiple call-service instances are running |
| MySQL | Friendship/block authorization and durable call history |

The call service never receives camera or microphone media unless Coturn must
relay it. It does not store recordings.

## Folder layout

```text
call-service/
├── src/
│   ├── auth.ts          # verifies short-lived tokens minted by PHP
│   ├── config.ts        # validated environment configuration
│   ├── db.ts            # INK friendship/block checks and call state
│   ├── schemas.ts       # strict Socket.IO payload validation
│   ├── server.ts        # HTTP, Socket.IO, Redis and health checks
│   ├── signaling.ts     # invite/accept/end/offer/answer/ICE flow
│   ├── turn.ts          # temporary Coturn REST credentials
│   └── types.ts
├── integration/
│   ├── call_token.php   # bridge from the INK PHP session
│   ├── ink-webrtc-client.js
│   └── example.php
├── migrations/
│   └── 001_rtc_calls.sql
├── deploy/
│   ├── Dockerfile
│   ├── docker-compose.yml
│   ├── nginx.conf
│   └── turnserver.conf.example
└── test/
```

## Local setup

1. Apply `migrations/001_rtc_calls.sql` to the existing INK database.
2. Create a least-privilege database user for this service:

```sql
CREATE USER 'ink_calls'@'%' IDENTIFIED BY 'replace-with-a-long-password';
GRANT SELECT ON blog_website.friendships TO 'ink_calls'@'%';
GRANT SELECT ON blog_website.blocks TO 'ink_calls'@'%';
GRANT SELECT ON blog_website.users TO 'ink_calls'@'%';
GRANT SELECT, INSERT, UPDATE ON blog_website.rtc_calls TO 'ink_calls'@'%';
FLUSH PRIVILEGES;
```

3. Copy `.env.example` to `.env`.
4. Generate two independent secrets:

```bash
openssl rand -base64 48
openssl rand -base64 48
```

Use one for `CALL_JWT_SECRET` and the other for `TURN_SHARED_SECRET`.
Add the same `CALL_JWT_SECRET` and `CALL_SERVICE_PUBLIC_URL=/calls` to INK's
PHP environment.

5. Install and run:

```bash
npm install
npm run dev
```

6. Copy:

- `integration/call_token.php` to `INK.APP/call_token.php`
- `integration/ink-webrtc-client.js` to `INK.APP/assets/js/ink-webrtc-client.js`

The relative `require` paths in `call_token.php` are correct after it is copied
to the `INK.APP` root. Use `integration/example.php` to connect the existing
buttons and overlay.

## Production deployment

1. Put the service and Coturn on a VPS with a public IPv4 address.
2. Point `turn.example.com` to that server.
3. Copy `turnserver.conf.example` to `turnserver.conf` and replace:
   - public IP;
   - realm/domain;
   - shared secret;
   - TLS certificate paths.
4. Open firewall ports:
   - TCP/UDP `3478`;
   - TCP `5349`;
   - UDP `49160-49200`.
5. Put the Nginx locations inside the INK HTTPS virtual host.
6. Run:

```bash
docker compose -f deploy/docker-compose.yml up -d --build
```

WebRTC camera/microphone access requires HTTPS outside localhost.

## Deploy to Render

1. Push this folder as its own GitHub repo.
2. In Render: **New + → Blueprint** and pick the repo — `render.yaml` provisions
   the Node web service (and an optional Redis instance) automatically.
3. Set the secrets it prompts for (`CALL_JWT_SECRET`, `ADMIN_SERVICE_SECRET`, `DB_*`).
   `CALL_JWT_SECRET` must match the one configured in **INK.APP**.
4. Set `APP_ORIGIN` to the INK app's origin (e.g. `https://ink-app.onrender.com`).
5. Point **INK.APP**'s `CALL_SERVICE_PUBLIC_URL` at this service's URL
   (e.g. `https://ink-call.onrender.com`).

Notes:

- The service starts **without TURN** (STUN-only) — it logs a warning and still
  runs; calls behind strict NATs may fail. For a managed provider, add
  `TURN_URL`, `TURN_TLS_URL`, `TURN_USERNAME`, and `TURN_CREDENTIAL`. For a
  self-hosted Coturn server, use `TURN_SHARED_SECRET` instead of the static
  username and credential.
- **Redis is optional.** Without `REDIS_URL` the call registry is in-process
  (fine for a single instance). Add the bundled Render Redis for multi-instance
  fan-out.
- Health checks: `GET /health/live` (liveness) and `GET /health/ready` (checks
  MySQL).

## Signalling events

| Client event | Server event | Purpose |
|---|---|---|
| `call:invite` | `call:incoming` | ring the other user |
| `call:accept` | `call:accepted` | accept and begin negotiation |
| `webrtc:description` | `webrtc:description` | exchange SDP offer/answer |
| `webrtc:ice-candidate` | `webrtc:ice-candidate` | exchange network candidates |
| `call:end` | `call:ended` | terminate and persist outcome |

Every event derives the sender from the verified socket token. Client-supplied
sender IDs are intentionally ignored.

## Scaling

Run more call-service containers behind a load balancer and keep Redis enabled.
Because the configuration forces WebSocket transport, load-balancer sticky
sessions are not required for polling upgrades. Redis forwards user-room events
between instances. Scale Coturn separately based on relay bandwidth.

## Group calls

Do not extend this one-to-one implementation into a browser mesh. Add a
self-hosted LiveKit SFU beside it. The call service should validate INK group
membership and issue short-lived LiveKit room grants; LiveKit should carry the
group media. The existing PHP token bridge and call-history model can remain.

