import { timingSafeEqual } from "node:crypto"
import { readFileSync } from "node:fs"
import { bodyLimit } from "hono/body-limit"
import {
  createShellServer,
  mountStatic,
  type RequestMetadata,
} from "@zsrobinson/shell/server"
import {
  DUPLEX,
  JOB_ID,
  MAX_BODY_BYTES,
  MAX_COPIES,
  MAX_FILE_BYTES,
  MAX_RECEIPT_CHARACTERS,
  pageRangeError,
  sniff,
} from "../src/lib/limits"
import type { PrintConfig } from "./config"
import {
  createCore,
  type BinaryType,
  type CoreFile,
  type CoreReply,
} from "./core"
import {
  cleanName,
  isPrinter,
  jobsSearch,
  linkUrl,
  statsSearch,
} from "./params"

export type PrintServerOptions = {
  config: Omit<PrintConfig, "port" | "bindAddress">
  /** Built assets. Every file under it is served only after Access succeeds. */
  staticRoot?: string
  log?: (metadata: RequestMetadata) => void
  fetch?: typeof fetch
}

const FILE_NAMES = {
  "application/pdf": "document.pdf",
  "image/png": "image.png",
  "image/jpeg": "image.jpg",
} as const

/** Download names for binary replies; never derived from the job's name. */
const DOWNLOAD_NAMES: Record<BinaryType, string> = {
  "application/pdf": "document.pdf",
  "image/png": "image.png",
  "image/jpeg": "image.jpg",
  "text/plain; charset=utf-8": "receipt.txt",
}
/** JSON or form fields for a link fetch: one URL and nothing else. */
const MAX_FETCH_BODY = 8 * 1024

function sameSecret(supplied: string | null, expected: string) {
  if (!supplied) return false
  const a = Buffer.from(supplied)
  const b = Buffer.from(`Bearer ${expected}`)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Load the external app-switcher manifest; a broken file only empties it. */
function readServices(path: string) {
  try {
    const services: unknown = JSON.parse(readFileSync(path, "utf8"))
    return Array.isArray(services) ? services : []
  } catch {
    return []
  }
}

type Rejection = { status: 400 | 413 | 415; error: string }

/**
 * Rebuild the job from allow-listed fields only. A document keeps its
 * original bytes; only its declared type and name are replaced with values
 * derived from its content.
 */
export async function buildJob(form: FormData): Promise<FormData | Rejection> {
  // null when absent; false when repeated or a file, which is never valid.
  const field = (name: string) => {
    const values = form.getAll(name)
    if (values.length !== 1) return values.length ? false : null
    return typeof values[0] === "string" ? values[0] : false
  }
  const printer = field("printer")
  const dryRun = field("dry_run") ?? "false"
  if (dryRun !== "true" && dryRun !== "false")
    return { status: 400, error: "dry_run must be true or false" }
  if (printer !== "document" && printer !== "receipt")
    return { status: 400, error: "Choose the document or receipt printer" }
  const job = new FormData()
  job.set("printer", printer)
  job.set("dry_run", dryRun)
  // The display name travels on its own; the file part keeps a generic name.
  const rawName = field("name")
  if (rawName === false) return { status: 400, error: "Send one name" }
  const name = rawName === null ? null : cleanName(rawName)
  if (name) job.set("name", name)

  if (printer === "receipt") {
    if (form.has("file"))
      return { status: 400, error: "Receipts print text, not files" }
    const raw = field("text")
    if (raw === false) return { status: 400, error: "Send one text field" }
    // Multipart encoding turns line breaks into CRLF; count what was typed.
    const text = (raw ?? "").replace(/\r\n?/g, "\n")
    if (!text.trim())
      return { status: 400, error: "Write the receipt text first" }
    if (text.length > MAX_RECEIPT_CHARACTERS)
      return { status: 413, error: "Receipts can be up to 10,000 characters" }
    job.set("text", text)
    return job
  }

  if (form.has("text"))
    return { status: 400, error: "Documents print a file, not text" }
  const files = form.getAll("file")
  const file = files[0]
  if (files.length !== 1 || !(file instanceof Blob))
    return { status: 400, error: "Choose one PDF or image to print" }
  if (file.size === 0) return { status: 400, error: "The file is empty" }
  if (file.size > MAX_FILE_BYTES)
    return { status: 413, error: "Files can be up to 10 MiB" }
  const type = sniff(new Uint8Array(await file.slice(0, 8).arrayBuffer()))
  if (!type)
    return { status: 415, error: "Only PDF, PNG and JPEG files can be printed" }

  const copies = field("copies") ?? "1"
  if (
    copies === false ||
    !/^[1-9]\d{0,2}$/.test(copies) ||
    Number(copies) > MAX_COPIES
  )
    return { status: 400, error: "Copies must be a whole number from 1 to 100" }
  const duplex = field("duplex") ?? "one-sided"
  if (duplex === false || !DUPLEX.includes(duplex as (typeof DUPLEX)[number]))
    return {
      status: 400,
      error: "Choose one-sided or a two-sided binding edge",
    }
  const pages = field("page_range")
  if (pages === false) return { status: 400, error: "Send one page range" }
  const range = pages?.trim() ?? ""
  if (range) {
    if (type !== "application/pdf")
      return { status: 400, error: "Page ranges apply to PDFs only" }
    const problem = pageRangeError(range)
    if (problem) return { status: 400, error: problem }
  }

  job.set("file", new File([file], FILE_NAMES[type], { type }))
  job.set("copies", copies)
  job.set("duplex", duplex)
  if (range) job.set("page_range", range)
  return job
}

export function createPrintServer({
  config,
  staticRoot = "./dist",
  log,
  fetch,
}: PrintServerOptions) {
  const app = createShellServer({
    issuer: config.issuer,
    audience: config.audience,
    publicOrigin: config.publicOrigin,
    services: () => readServices(config.serviceManifest),
    log,
    // A separate scrape token never grants access to app routes.
    metrics: {
      authorize: (request) =>
        Boolean(config.metricsToken) &&
        sameSecret(request.headers.get("Authorization"), config.metricsToken!),
    },
  })
  const core = createCore({
    origin: config.coreOrigin,
    token: config.coreToken,
    fetch,
  })
  const reply = (
    c: { json: (body: unknown, status: CoreReply["status"]) => Response },
    result: CoreReply
  ) => c.json(result.body, result.status)

  app.use("/api/*", async (c, next) => {
    await next()
    c.header("Cache-Control", "no-store")
  })
  const send = (
    c: {
      json: (body: unknown, status: CoreReply["status"]) => Response
      body: (
        data: Uint8Array<ArrayBuffer>,
        status: 200,
        headers: Record<string, string>
      ) => Response
    },
    result: CoreFile | CoreReply
  ) =>
    "bytes" in result
      ? c.body(result.bytes as Uint8Array<ArrayBuffer>, 200, {
          "Content-Type": result.type,
          "Content-Length": String(result.bytes.byteLength),
          "Content-Disposition": `attachment; filename="${DOWNLOAD_NAMES[result.type]}"`,
          "Cache-Control": "no-store",
        })
      : reply(c, result)

  app.get("/api/printers", async (c) =>
    reply(c, await core("GET", "/internal/printers", { timeoutMs: 10_000 }))
  )
  app.get("/api/printers/:id", async (c) => {
    const id = c.req.param("id")
    if (!isPrinter(id)) return c.json({ error: "Unknown printer" }, 404)
    return reply(
      c,
      await core("GET", `/internal/printers/${id}`, { timeoutMs: 10_000 })
    )
  })
  app.post("/api/printers/:id/check", async (c) => {
    const id = c.req.param("id")
    if (!isPrinter(id)) return c.json({ error: "Unknown printer" }, 404)
    return reply(
      c,
      await core("POST", `/internal/printers/${id}/check`, {
        timeoutMs: 30_000,
      })
    )
  })
  app.get("/api/jobs", async (c) => {
    const search = jobsSearch((name) => c.req.queries(name) ?? [])
    if (!(search instanceof URLSearchParams))
      return c.json({ error: search.error }, 400)
    const query = search.size ? `?${search}` : ""
    return reply(
      c,
      await core("GET", `/internal/jobs${query}`, { timeoutMs: 10_000 })
    )
  })
  app.get("/api/jobs/:id", async (c) => {
    const id = c.req.param("id")
    if (!JOB_ID.test(id)) return c.json({ error: "Unknown job" }, 400)
    return reply(
      c,
      await core("GET", `/internal/jobs/${encodeURIComponent(id)}`, {
        timeoutMs: 10_000,
      })
    )
  })
  app.get("/api/jobs/:id/file", async (c) => {
    const id = c.req.param("id")
    if (!JOB_ID.test(id)) return c.json({ error: "Unknown job" }, 400)
    return send(
      c,
      await core.file("GET", `/internal/jobs/${encodeURIComponent(id)}/file`, {
        timeoutMs: 30_000,
      })
    )
  })
  app.get("/api/stats", async (c) => {
    const search = statsSearch((name) => c.req.queries(name) ?? [])
    if (!(search instanceof URLSearchParams))
      return c.json({ error: search.error }, 400)
    const query = search.size ? `?${search}` : ""
    return reply(
      c,
      await core("GET", `/internal/stats${query}`, { timeoutMs: 10_000 })
    )
  })
  app.post(
    "/api/fetch",
    bodyLimit({
      maxSize: MAX_FETCH_BODY,
      onError: (c) =>
        c.json({ error: "Links can be up to 2,048 characters" }, 413),
    }),
    async (c) => {
      const type = c.req.header("Content-Type")?.toLowerCase() ?? ""
      let value: unknown
      try {
        if (type.startsWith("application/json")) {
          const body: unknown = await c.req.json()
          if (!body || typeof body !== "object" || Array.isArray(body))
            return c.json({ error: "Send the link as {url}" }, 400)
          value = (body as { url?: unknown }).url
        } else if (
          type.startsWith("application/x-www-form-urlencoded") ||
          type.startsWith("multipart/form-data")
        ) {
          const values = (await c.req.raw.formData()).getAll("url")
          value = values.length === 1 ? values[0] : undefined
        } else
          return c.json({ error: "Send the link as JSON or form data" }, 415)
      } catch {
        return c.json({ error: "The request was incomplete or malformed" }, 400)
      }
      const url = linkUrl(value)
      if (typeof url !== "string") return c.json({ error: url.error }, 400)
      const form = new FormData()
      form.set("url", url)
      return send(
        c,
        await core.file("POST", "/internal/fetch", {
          body: form,
          timeoutMs: 60_000,
          types: ["application/pdf"],
        })
      )
    }
  )
  app.post(
    "/api/jobs",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ error: "Files can be up to 10 MiB" }, 413),
    }),
    async (c) => {
      const type = c.req.header("Content-Type")?.toLowerCase() ?? ""
      if (!type.startsWith("multipart/form-data"))
        return c.json({ error: "Send the job as multipart form data" }, 415)
      let form: FormData
      try {
        form = await c.req.raw.formData()
      } catch {
        return c.json({ error: "The upload was incomplete or malformed" }, 400)
      }
      const job = await buildJob(form)
      if (!(job instanceof FormData))
        return c.json({ error: job.error }, job.status)
      return reply(
        c,
        await core("POST", "/internal/jobs", { body: job, timeoutMs: 60_000 })
      )
    }
  )
  app.post("/api/jobs/:id/cancel", async (c) => {
    const id = c.req.param("id")
    if (!JOB_ID.test(id)) return c.json({ error: "Unknown job" }, 400)
    return reply(
      c,
      await core("POST", `/internal/jobs/${encodeURIComponent(id)}/cancel`, {
        timeoutMs: 30_000,
      })
    )
  })
  // Unknown API paths must not fall through to the HTML navigation fallback.
  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404))
  mountStatic(app, staticRoot)
  return app
}
