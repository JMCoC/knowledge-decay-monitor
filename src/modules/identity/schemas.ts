import { z } from "zod";

const emailSchema = z.string().trim().email("Enter a valid email address.");
const nonEmptyPasswordSchema = z.string().min(1, "Enter your password.");
const newPasswordSchema = z.string().min(6, "Password must be at least 6 characters.");

export const loginSchema = z.strictObject({
  email: emailSchema,
  password: nonEmptyPasswordSchema,
});

export const registerSchema = z
  .strictObject({
    email: emailSchema,
    password: newPasswordSchema,
    confirmPassword: newPasswordSchema,
  })
  .refine((data) => data.password === data.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords must match.",
  });

export const forgotPasswordSchema = z.strictObject({ email: emailSchema });

export const resetPasswordSchema = z
  .strictObject({
    password: newPasswordSchema,
    confirmPassword: newPasswordSchema,
  })
  .refine((data) => data.password === data.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords must match.",
  });

export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
