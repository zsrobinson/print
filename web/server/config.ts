/** Runtime settings, read once at startup. Secrets stay in the environment. */
export type PrintConfig = {
  issuer: string
  audience: string
  publicOrigin: string
  serviceManifest: string
  coreOrigin: string
  coreToken: string
  metricsToken?: string
  port: number
  bindAddress: string
}

export const DEFAULT_CORE_URL = "http://127.0.0.1:8765"
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"])

/**
 * The core token is a bearer credential, so it may only travel to a loopback
 * origin. Anything with a path, query, credentials or another host is refused.
 */
export function coreOrigin(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw Error("PRINT_CORE_URL must be an absolute URL")
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !LOOPBACK.has(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw Error(
      "PRINT_CORE_URL must be a loopback origin such as " + DEFAULT_CORE_URL
    )
  return url.origin
}

export function loadConfig(env: NodeJS.ProcessEnv): PrintConfig {
  const required = (key: string) => {
    const value = env[key]?.trim()
    if (!value) throw Error(`Missing ${key}`)
    return value
  }
  const port = Number(env.PORT || 8787)
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error("PORT must be a TCP port")
  return {
    issuer: required("ACCESS_ISSUER"),
    audience: required("ACCESS_AUD"),
    publicOrigin: required("PUBLIC_ORIGIN"),
    serviceManifest: required("SERVICE_MANIFEST"),
    coreOrigin: coreOrigin(env.PRINT_CORE_URL?.trim() || DEFAULT_CORE_URL),
    coreToken: required("PRINT_CORE_TOKEN"),
    metricsToken: env.METRICS_TOKEN?.trim() || undefined,
    port,
    bindAddress: env.BIND_ADDRESS?.trim() || "127.0.0.1",
  }
}
