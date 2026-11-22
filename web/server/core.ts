/**
 * The only client of the loopback print core. The bearer token is attached
 * here and nowhere else; browser headers, cookies and query strings are never
 * forwarded, and core responses are re-serialised so none of its headers leak.
 */
import { MAX_BODY_BYTES, sniff } from "../src/lib/limits"

export type CoreReply = {
  status: 200 | 201 | 400 | 404 | 409 | 413 | 415 | 422 | 429 | 502 | 504
  body: unknown
}

/** Raw bytes from the core, already checked against the allow-list. */
export type CoreFile = { status: 200; type: BinaryType; bytes: Uint8Array }

/** The only content types a binary reply may carry to the browser. */
export const BINARY_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "text/plain; charset=utf-8",
] as const
export type BinaryType = (typeof BINARY_TYPES)[number]

const RELAYED = new Set([400, 404, 409, 413, 415, 422, 429])
const MAX_REPLY_BYTES = 4 * 1024 * 1024
/** One kept document or fetched PDF, plus slack. */
export const MAX_BINARY_BYTES = MAX_BODY_BYTES

const UNAVAILABLE: CoreReply = {
  status: 502,
  body: { error: "Print service unavailable" },
}
const INVALID: CoreReply = {
  status: 502,
  body: { error: "Print service sent an invalid reply" },
}

/** A bounded, printable message from the core, or null. */
function message(body: unknown) {
  if (!body || typeof body !== "object" || !("error" in body)) return null
  const text = String((body as { error: unknown }).error)
    .replace(/\p{C}+/gu, " ")
    .trim()
  return text ? text.slice(0, 300) : null
}

/** Normalise a declared type to one allow-listed value, or null. */
export function binaryType(header: string | null): BinaryType | null {
  if (!header) return null
  const [media, ...params] = header
    .split(";")
    .map((p) => p.trim().toLowerCase())
  if (media === "text/plain") {
    const charset = params.find((p) => p.startsWith("charset="))
    const value = charset?.slice(8).replace(/^"|"$/g, "")
    return !value || value === "utf-8" || value === "utf8"
      ? "text/plain; charset=utf-8"
      : null
  }
  return BINARY_TYPES.includes(media as BinaryType)
    ? (media as BinaryType)
    : null
}

/** Read at most `limit` bytes; null when the body is larger. */
async function readCapped(response: Response, limit: number) {
  const declared = Number(response.headers.get("Content-Length") || 0)
  if (declared > limit) {
    await response.body?.cancel().catch(() => {})
    return null
  }
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function readJson(response: Response) {
  try {
    const bytes = await readCapped(response, MAX_REPLY_BYTES)
    if (!bytes) return undefined
    const text = new TextDecoder().decode(bytes)
    return text ? (JSON.parse(text) as unknown) : null
  } catch {
    return undefined
  }
}

/** Relay a core rejection as a bounded message; anything else is a 502. */
async function failure(response: Response): Promise<CoreReply> {
  if (RELAYED.has(response.status))
    return {
      status: response.status as CoreReply["status"],
      body: {
        error:
          message(await readJson(response)) ??
          "Print service rejected the request",
      },
    }
  await response.body?.cancel().catch(() => {})
  // 401/403 mean this server's core credential is wrong, not the viewer's.
  return UNAVAILABLE
}

type Options = { body?: FormData; timeoutMs: number }

export function createCore({
  origin,
  token,
  fetch: send = fetch,
}: {
  origin: string
  token: string
  fetch?: typeof fetch
}) {
  async function request(
    method: "GET" | "POST",
    path: `/internal/${string}`,
    { body, timeoutMs }: Options,
    accept: string
  ): Promise<{ response: Response } | { reply: CoreReply }> {
    // Tagged rather than `instanceof Response`: @hono/node-server replaces
    // the global Response, so fetch's responses are not instances of it.
    try {
      const response = await send(origin + path, {
        method,
        body,
        headers: { Authorization: `Bearer ${token}`, Accept: accept },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      })
      return { response }
    } catch (error) {
      const timedOut =
        error instanceof DOMException && error.name === "TimeoutError"
      if (!timedOut) return { reply: UNAVAILABLE }
      return {
        reply: {
          status: 504,
          body: {
            error:
              method === "GET"
                ? "Print service timed out"
                : "Print service did not answer in time. Check the queue before trying again.",
          },
        },
      }
    }
  }

  async function call(
    method: "GET" | "POST",
    path: `/internal/${string}`,
    options: Options
  ): Promise<CoreReply> {
    const result = await request(method, path, options, "application/json")
    if ("reply" in result) return result.reply
    const { response } = result
    if (response.status !== 200 && response.status !== 201)
      return failure(response)
    const parsed = await readJson(response)
    if (parsed && typeof parsed === "object")
      return { status: response.status, body: parsed }
    return INVALID
  }

  /**
   * A raw body from the core: only allow-listed types, at most one document
   * plus slack, and for documents the leading bytes must match the type.
   */
  async function file(
    method: "GET" | "POST",
    path: `/internal/${string}`,
    options: Options & { types?: readonly BinaryType[] }
  ): Promise<CoreFile | CoreReply> {
    const result = await request(
      method,
      path,
      options,
      (options.types ?? BINARY_TYPES).join(", ") + ", application/json"
    )
    if ("reply" in result) return result.reply
    const { response } = result
    if (response.status !== 200) return failure(response)
    const type = binaryType(response.headers.get("Content-Type"))
    if (!type || !(options.types ?? BINARY_TYPES).includes(type)) {
      await response.body?.cancel().catch(() => {})
      return INVALID
    }
    let bytes: Uint8Array | null
    try {
      bytes = await readCapped(response, MAX_BINARY_BYTES)
    } catch {
      return UNAVAILABLE
    }
    if (!bytes) return INVALID
    if (type === "text/plain; charset=utf-8") {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      } catch {
        return INVALID
      }
    } else if (sniff(bytes) !== type) return INVALID
    return { status: 200, type, bytes }
  }

  return Object.assign(call, { file })
}

export type CoreCall = ReturnType<typeof createCore>
