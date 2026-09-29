import { describe, expect, it } from "vitest";
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
} from "../../src/modules/identity/schemas";

describe("Auth input schemas", () => {
  it("trims email while preserving password characters exactly", () => {
    const result = loginSchema.parse({ email: "  member@example.com  ", password: "  p  " });

    expect(result).toEqual({ email: "member@example.com", password: "  p  " });
  });

  it("requires a non-empty login password and valid email", () => {
    expect(loginSchema.safeParse({ email: "not-email", password: "" }).success).toBe(false);
  });

  it("requires a six-character registration password and matching confirmation", () => {
    expect(
      registerSchema.safeParse({
        email: "member@example.com",
        password: "  abcde",
        confirmPassword: "  abcde",
      }),
    ).toMatchObject({ success: true });
    expect(
      registerSchema.safeParse({
        email: "member@example.com",
        password: "abcde",
        confirmPassword: "abcde",
      }).success,
    ).toBe(false);
    expect(
      registerSchema.safeParse({
        email: "member@example.com",
        password: "abcdef",
        confirmPassword: "different",
      }).success,
    ).toBe(false);
  });

  it("validates recovery email and reset password without trimming the password", () => {
    expect(forgotPasswordSchema.parse({ email: " member@example.com " })).toEqual({
      email: "member@example.com",
    });
    expect(
      resetPasswordSchema.parse({ password: "  abcde", confirmPassword: "  abcde" }),
    ).toEqual({ password: "  abcde", confirmPassword: "  abcde" });
    expect(resetPasswordSchema.safeParse({ password: "abcde", confirmPassword: "abcde" }).success)
      .toBe(false);
  });

  it("rejects extra auth fields instead of accepting client-supplied authority", () => {
    expect(
      registerSchema.safeParse({
        email: "member@example.com",
        password: "abcdef",
        confirmPassword: "abcdef",
        role: "Admin",
        workspaceId: "attacker",
        userId: "attacker",
      }).success,
    ).toBe(false);
  });
});
