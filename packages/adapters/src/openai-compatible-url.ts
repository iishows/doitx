import {
  ipVersion,
  isCloudMetadataHost,
  isLinkLocalAddress,
  isLoopbackHost,
  isNonPublicAddress,
  normalizeHost,
  normalizeOpenAiCompatibleBaseUrl,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from "@rakazo/contracts";

export { normalizeOpenAiCompatibleBaseUrl, OPENAI_COMPATIBLE_PROVIDER_ID };

const BUILT_IN_PUBLIC_MODEL_HOSTS = new Set(["ollama.com"]);

export function openAiCompatAllowPublicHosts(): boolean {
  return process.env.RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC !== "0";
}

export function isPrivateOpenAiCompatibleHostname(hostname: string): boolean {
  const normalized = normalizeHost(hostname);
  if (isLoopbackHost(normalized) || normalized === "host.docker.internal") return true;
  if (isCloudMetadataHost(normalized)) return false;
  if (ipVersion(normalized) !== 0) return isNonPublicAddress(normalized);
  return (process.env.RAKAZO_OPENAI_COMPAT_PRIVATE_HOSTS ?? "")
    .split(",")
    .some((entry) => entry.trim() !== "" && normalizeHost(entry.trim()) === normalized);
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = normalizeHost(hostname);
  return (
    isCloudMetadataHost(normalized) ||
    (ipVersion(normalized) !== 0 && isLinkLocalAddress(normalized))
  );
}

/**
 * Who may reach which model endpoints. `allowPrivate` comes from
 * operator configuration; absent means deny.
 *
 * `allowPinnedLocalOrigin` is narrower than `allowPrivate`: it clears the
 * private-address refusal for exactly one cleartext origin — this machine's own
 * local model server — so the catalog can probe it without opening LAN addresses.
 */
export type OpenAiCompatibleUrlPolicy = {
  allowPublic?: boolean;
  allowPrivate?: boolean;
  allowPinnedLocalOrigin?: boolean;
};

export const PRIVATE_MODEL_ENDPOINT_MESSAGE =
  "Private model endpoints require operator authorization.";

/** The deployment's default local endpoint, and the only cleartext origin a probe may reach. */
export const PINNED_LOCAL_PROBE_ORIGIN = "http://127.0.0.1:3456";

/**
 * Hostnames that all name this machine's own local model server. The desktop app runs
 * the API in a container, where Docker resolves `host.docker.internal` back to the host
 * that runs the endpoint; the container's `127.0.0.1` is the container itself.
 */
const PINNED_LOCAL_PROBE_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "host.docker.internal",
]);

/**
 * Whether `raw` is the pinned local probe origin. Matches the origin only, so the
 * `/v1` suffix and any other path are accepted; a different host, scheme, or port
 * is not. The catalog pins the local probe to this one address because it is the
 * deployment's own server, never a caller-supplied endpoint.
 */
export function isPinnedLocalProbeOrigin(raw: string | URL): boolean {
  let url: URL;
  try {
    url = typeof raw === "string" ? new URL(raw) : raw;
  } catch {
    return false;
  }
  const pinned = new URL(PINNED_LOCAL_PROBE_ORIGIN);
  return (
    url.protocol === pinned.protocol &&
    url.port === pinned.port &&
    PINNED_LOCAL_PROBE_HOSTS.has(normalizeHost(url.hostname))
  );
}

export function assertAllowedOpenAiCompatibleUrl(
  raw: string,
  opts?: OpenAiCompatibleUrlPolicy,
): URL {
  const normalized = normalizeOpenAiCompatibleBaseUrl(raw);
  return assertAllowedOpenAiCompatibleRequestUrl(normalized, opts);
}

/**
 * When an API key will be sent, refuse public http:// endpoints so the Bearer
 * token is not cleartext on the public internet. Private / loopback http stays
 * allowed (local model servers). https:// is always fine for this check.
 */
export function assertHttpsForKeyedOpenAiCompatibleUrl(
  url: URL,
  apiKey: string | undefined | null,
  hasHeaders = false,
): void {
  if (!apiKey?.trim() && !hasHeaders) return;
  if (url.protocol === "https:") return;
  const hostname = normalizeHost(url.hostname);
  if (isPrivateOpenAiCompatibleHostname(hostname)) return;
  throw new Error(
    hasHeaders
      ? "OpenAI-compatible endpoints that send an API key or custom headers must use HTTPS. Use an https:// URL, or omit the API key and custom headers on a private HTTP endpoint."
      : "OpenAI-compatible endpoints that send an API key must use HTTPS. Use an https:// URL, or omit the API key on a private HTTP endpoint.",
  );
}

export function assertAllowedOpenAiCompatibleRequestUrl(
  raw: string,
  opts?: OpenAiCompatibleUrlPolicy,
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Model server URL must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Model server URL must use http or https");
  }
  if (url.username || url.password) {
    throw new Error("Model server URL must not contain credentials");
  }
  const hostname = normalizeHost(url.hostname);
  if (isBlockedHostname(hostname)) {
    throw new Error("Base URL targets a blocked metadata or link-local host");
  }
  const allowPublic = opts?.allowPublic ?? openAiCompatAllowPublicHosts();
  if (isPrivateOpenAiCompatibleHostname(hostname)) {
    if (opts?.allowPrivate === true) return url;
    // A pinned local origin is a known loopback address, not an arbitrary private host,
    // so it clears this refusal without the operator opening the whole LAN.
    if (opts?.allowPinnedLocalOrigin === true && isPinnedLocalProbeOrigin(url)) return url;
    throw new Error(PRIVATE_MODEL_ENDPOINT_MESSAGE);
  }
  const builtInPublicHost =
    url.protocol === "https:" && url.port === "" && BUILT_IN_PUBLIC_MODEL_HOSTS.has(url.hostname);
  if (!allowPublic && !builtInPublicHost) {
    throw new Error("Public model endpoints are disabled on this server.");
  }
  return url;
}
