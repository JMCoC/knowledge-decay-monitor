const APP_ORIGIN = "http://127.0.0.1:3000";
const DEADLINE_MS = 15_000;

function mailpitBase() {
  let url;
  try {
    url = new URL(process.env.KDM_MAILPIT_URL ?? "");
  } catch {
    throw new Error("Local Mailpit URL is missing.");
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname) ||
    url.port !== "54324"
  ) {
    throw new Error("Refusing to read email from a non-local Mailpit host.");
  }
  return url;
}

function messageId(message) {
  return message.ID ?? message.Id ?? message.id ?? null;
}

function recoveryLink(html) {
  const anchors = [...html.matchAll(/href\s*=\s*(["'])(.*?)\1/gi)];
  for (const anchor of anchors) {
    const href = anchor[2].replaceAll("&amp;", "&").replaceAll("&#38;", "&");
    if (!href.includes("/auth/callback?")) continue;
    let link;
    try {
      link = new URL(href, APP_ORIGIN);
    } catch {
      continue;
    }
    if (
      link.origin === APP_ORIGIN &&
      link.pathname === "/auth/callback" &&
      link.searchParams.get("type") === "recovery" &&
      link.searchParams.get("token_hash")
    ) {
      return link.toString();
    }
  }
  return null;
}

export function tokenHashFromRecoveryLink(link) {
  const parsed = new URL(link);
  if (parsed.origin !== APP_ORIGIN || parsed.pathname !== "/auth/callback") {
    throw new Error("Recovery email did not contain the expected local callback.");
  }
  const tokenHash = parsed.searchParams.get("token_hash");
  if (!tokenHash || parsed.searchParams.get("type") !== "recovery") {
    throw new Error("Recovery email callback parameters are invalid.");
  }
  return tokenHash;
}

export async function waitForRecoveryLink(email, { excludedTokenHashes = [] } = {}) {
  const base = mailpitBase();
  const deadline = Date.now() + DEADLINE_MS;

  while (Date.now() < deadline) {
    try {
      const searchUrl = new URL("/api/v1/search", base);
      searchUrl.searchParams.set("query", `to:${email}`);
      searchUrl.searchParams.set("limit", "20");
      const response = await fetch(searchUrl, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        const result = await response.json();
        for (const message of result.messages ?? []) {
          const id = messageId(message);
          if (!id) continue;
          const bodyResponse = await fetch(new URL(`/view/${encodeURIComponent(id)}.html`, base), {
            signal: AbortSignal.timeout(3000),
          });
          if (!bodyResponse.ok) continue;
          const link = recoveryLink(await bodyResponse.text());
          if (link && !excludedTokenHashes.includes(tokenHashFromRecoveryLink(link))) return link;
        }
      }
    } catch {
      // Mailpit may still be indexing the just-sent message; retry until deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw new Error("Local recovery email did not arrive within 15 seconds.");
}
