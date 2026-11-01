import { validateAppOrigin, validateNotificationsFrom } from "./config";
import type { NotificationBody, NotificationContext } from "./types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

function validatedContext(context: NotificationContext) {
  if (
    !UUID_PATTERN.test(context.eventId)
    || !UUID_PATTERN.test(context.analysisId)
    || !UUID_PATTERN.test(context.workspaceId)
    || !UUID_PATTERN.test(context.recipientId)
    || context.recipientEmail.length > 254
    || !EMAIL_PATTERN.test(context.recipientEmail)
    || (context.type !== "analysis_completed" && context.type !== "analysis_failed")
  ) {
    throw new Error("Notification context is invalid.");
  }

  const finishedAt = new Date(context.finishedAt);
  if (!Number.isFinite(finishedAt.getTime())) {
    throw new Error("Notification context is invalid.");
  }

  return { recipientEmail: context.recipientEmail, analysisId: context.analysisId, finishedAt: finishedAt.toISOString() };
}

export function renderTerminalNotification(
  context: NotificationContext,
  config: { from: string; appOrigin: string },
): NotificationBody {
  const safeContext = validatedContext(context);
  const from = validateNotificationsFrom(config.from);
  const appOrigin = validateAppOrigin(config.appOrigin);
  const loginUrl = new URL("/login", appOrigin);
  loginUrl.searchParams.set("analysisId", safeContext.analysisId);

  const completed = context.type === "analysis_completed";
  const message = completed
    ? "Your analysis is complete. Sign in to review the results."
    : "Your analysis could not be completed. Sign in to review its status and available next steps.";
  const subject = completed
    ? "Your analysis is complete"
    : "Your analysis could not be completed";
  const timeLabel = completed ? "Completed at" : "Failed at";
  const safeAnalysisId = escapeHtml(safeContext.analysisId);
  const safeFinishedAt = escapeHtml(safeContext.finishedAt);
  const safeLoginUrl = escapeHtml(loginUrl.href);
  const html = [
    "<!doctype html>",
    '<html lang="en">',
    "<body>",
    `<p>${message}</p>`,
    `<p><strong>Analysis ID:</strong> <code>${safeAnalysisId}</code></p>`,
    `<p><strong>${timeLabel}:</strong> ${safeFinishedAt}</p>`,
    `<p><a href="${safeLoginUrl}">View analysis</a></p>`,
    "</body>",
    "</html>",
  ].join("");
  const text = [
    message,
    "",
    `Analysis ID: ${safeContext.analysisId}`,
    `${timeLabel}: ${safeContext.finishedAt}`,
    "",
    `View analysis: ${loginUrl.href}`,
  ].join("\n");

  return {
    from,
    to: [safeContext.recipientEmail],
    subject,
    html,
    text,
  };
}
