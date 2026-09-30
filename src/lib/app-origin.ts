const LOCAL_APP_ORIGIN = "http://127.0.0.1:3000";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Resolve the trusted app origin for redirects and Auth recovery callbacks. */
export function getAppOrigin(): string {
  const configuredOrigin = process.env.APP_ORIGIN;
  const isVercel = process.env.VERCEL === "1";

  if (configuredOrigin === undefined) {
    if (isVercel) throw new Error("APP_ORIGIN is required on Vercel");
    return LOCAL_APP_ORIGIN;
  }

  let parsedOrigin: URL;
  try {
    if (configuredOrigin !== configuredOrigin.trim()) throw new Error();
    parsedOrigin = new URL(configuredOrigin);
  } catch {
    throw new Error("APP_ORIGIN is invalid");
  }

  const isLoopback = LOOPBACK_HOSTS.has(parsedOrigin.hostname);
  if (
    !["http:", "https:"].includes(parsedOrigin.protocol) ||
    parsedOrigin.username !== "" ||
    parsedOrigin.password !== "" ||
    parsedOrigin.pathname !== "/" ||
    parsedOrigin.search !== "" ||
    parsedOrigin.hash !== "" ||
    (parsedOrigin.protocol === "http:" && (!isLoopback || isVercel))
  ) {
    throw new Error("APP_ORIGIN is invalid");
  }

  return parsedOrigin.origin;
}
