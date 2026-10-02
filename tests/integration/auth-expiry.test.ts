import { describe, expect, it } from "vitest";
import { expiredSignedAccessToken, newLocalUser } from "../support/local-supabase";

describe("local Auth token expiry", () => {
  it("rejects a valid signed access token after its expiry", async () => {
    const { client } = await newLocalUser();
    const { data: { session }, error: sessionError } = await client.auth.getSession();
    if (sessionError || !session) throw new Error("The synthetic local Auth user has no session.");

    const expiredToken = expiredSignedAccessToken(session.access_token);
    const expired = await client.auth.getUser(expiredToken);

    expect(expired.error).not.toBeNull();
    expect(expired.data.user).toBeNull();
    expect(expired.error?.status).toBe(403);
    expect(expired.error?.message).toMatch(/expired/i);
  });

  it("rejects a malformed access token without classifying it as expired", async () => {
    const { client } = await newLocalUser();
    const malformed = await client.auth.getUser("not-a-valid-jwt.fixture");

    expect(malformed.error).not.toBeNull();
    expect(malformed.data.user).toBeNull();
    expect(malformed.error?.message).not.toMatch(/expired/i);
  });
});
