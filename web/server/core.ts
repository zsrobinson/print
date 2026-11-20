/**
 * The only client of the loopback print core. The bearer token is attached
 * here and nowhere else; browser headers, cookies and query strings are never
 * forwarded, and core responses are re-serialised so none of its headers leak.
 */
export type CoreReply = {
  status: 200 | 201 | 400 | 404 | 409 | 413 | 415 | 422 | 429 | 502 | 504
  body: unknown
}

const RELAYED = new Set([400, 404, 409, 413, 415, 422, 429])
const MAX_REPLY_BYTES = 4 * 1024 * 1024

/** A bounded, printable message from the core, or null. */
function message(body: unknown) {
  if (!body || typeof body !== "object" || !("error" in body)) return null
  const text = String((body as { error: unknown }).error)
    .replace(/\p{C}+/gu, " ")
    .trim()
  return text ? text.slice(0, 300) : null
}

export function createCore({
  origin,
  token,
  fetch: send = fetch,
}: {
  origin: string
  token: string
  fetch?: typeof fetch
}) {
  return async function call(
    method: "GET" | "POST",
    path: `/internal/${string}`,
    { body, timeoutMs }: { body?: FormData; timeoutMs: number }
  ): Promise<CoreReply> {
    let response: Response
    try {
      response = await send(origin + path, {
        method,
        body,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const timedOut =
        error instanceof DOMException && error.name === "TimeoutError"
      if (!timedOut)
        return { status: 502, body: { error: "Print service unavailable" } }
      return {
        status: 504,
        body: {
          error:
            method === "GET"
              ? "Print service timed out"
              : "Print service did not answer in time. Check the queue before trying again.",
        },
      }
    }
    let parsed: unknown
    try {
      const declared = Number(response.headers.get("Content-Length") || 0)
      if (declared > MAX_REPLY_BYTES) throw Error("Reply too large")
      const text = await response.text()
      if (text.length > MAX_REPLY_BYTES) throw Error("Reply too large")
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = undefined
    }
    if (response.status === 200 || response.status === 201) {
      if (parsed && typeof parsed === "object")
        return { status: response.status, body: parsed }
      return {
        status: 502,
        body: { error: "Print service sent an invalid reply" },
      }
    }
    if (RELAYED.has(response.status))
      return {
        status: response.status as CoreReply["status"],
        body: {
          error: message(parsed) ?? "Print service rejected the request",
        },
      }
    // 401/403 mean this server's core credential is wrong, not the viewer's.
    return { status: 502, body: { error: "Print service unavailable" } }
  }
}

export type CoreCall = ReturnType<typeof createCore>
