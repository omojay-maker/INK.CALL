import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";

describe("TURN REST credentials", () => {
  it("uses the timestamp:user HMAC-SHA1 format expected by coturn", () => {
    const secret = "a-test-secret-that-is-long-enough-to-be-valid";
    const username = "2000000000:42";
    const credential = createHmac("sha1", secret).update(username).digest("base64");
    expect(credential).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(credential).toBe(createHmac("sha1", secret).update(username).digest("base64"));
  });
});

