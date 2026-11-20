/**
 * A stand-in for the print core with invented data, for screenshots and local
 * development. It never talks to CUPS: every submission must be a dry run.
 */
import { createHash } from "node:crypto"
import { createServer, type Server } from "node:http"

// Relative to start-up, so ages read naturally in screenshots.
const NOW = Date.now()
const minutes = (n: number) => new Date(NOW - n * 60_000).toISOString()

type Job = {
  id: string
  cups_id?: string | null
  printer: "document" | "receipt"
  source: "web" | "mcp"
  state: string
  pages: number | null
  copies: number
  created_at: string
  dry_run: boolean
}

function seed(): Job[] {
  return [
    {
      id: "document-118",
      printer: "document",
      source: "web",
      state: "processing",
      pages: 12,
      copies: 2,
      created_at: minutes(1),
      dry_run: false,
    },
    {
      id: "document-119",
      printer: "document",
      source: "mcp",
      state: "pending",
      pages: 3,
      copies: 1,
      created_at: minutes(0.5),
      dry_run: false,
    },
    {
      id: "receipt-41",
      printer: "receipt",
      source: "mcp",
      state: "completed",
      pages: 1,
      copies: 1,
      created_at: minutes(18),
      dry_run: false,
    },
    {
      id: "document-117",
      printer: "document",
      source: "web",
      state: "completed",
      pages: 4,
      copies: 1,
      created_at: minutes(52),
      dry_run: false,
    },
    {
      id: "document-116",
      printer: "document",
      source: "mcp",
      state: "aborted",
      pages: 9,
      copies: 1,
      created_at: minutes(140),
      dry_run: false,
    },
    {
      id: "receipt-40",
      printer: "receipt",
      source: "web",
      state: "completed",
      pages: 1,
      copies: 1,
      created_at: minutes(260),
      dry_run: true,
    },
    {
      id: "document-115",
      printer: "document",
      source: "web",
      state: "canceled",
      pages: 30,
      copies: 1,
      created_at: minutes(600),
      dry_run: false,
    },
    {
      id: "document-114",
      printer: "document",
      source: "web",
      state: "completed",
      pages: 1,
      copies: 3,
      created_at: minutes(1500),
      dry_run: false,
    },
    {
      id: "receipt-39",
      printer: "receipt",
      source: "mcp",
      state: "completed",
      pages: 1,
      copies: 1,
      created_at: minutes(2900),
      dry_run: false,
    },
  ]
}

function stats() {
  const daily = []
  for (let day = 20; day >= 0; day--) {
    const date = new Date(NOW - day * 86_400_000).toISOString().slice(0, 10)
    const wave = (day * 7) % 5
    if (day % 6 === 3) continue // A quiet day shows as a gap.
    daily.push(
      {
        date,
        printer: "document",
        source: "web",
        jobs: 1 + (wave % 3),
        pages: 4 + wave * 3,
        failures: day === 12 ? 1 : 0,
      },
      {
        date,
        printer: "document",
        source: "mcp",
        jobs: wave % 2,
        pages: (wave % 2) * 6,
        failures: day === 5 ? 1 : 0,
      },
      {
        date,
        printer: "receipt",
        source: "mcp",
        jobs: 1 + ((day + 1) % 3),
        pages: 1 + ((day + 1) % 3),
        failures: 0,
      },
      {
        date,
        printer: "receipt",
        source: "web",
        jobs: day % 4 === 0 ? 1 : 0,
        pages: day % 4 === 0 ? 1 : 0,
        failures: 0,
      }
    )
  }
  const totals = daily.reduce(
    (sum, row) => ({
      jobs: sum.jobs + row.jobs,
      pages: sum.pages + row.pages,
      failures: sum.failures + row.failures,
    }),
    { jobs: 0, pages: 0, failures: 0 }
  )
  return { daily, totals }
}

export function createFixtureCore(token: string): Server {
  const initial = () =>
    seed().map((job) => ({
      ...job,
      cups_id: job.dry_run ? null : job.id,
      id: createHash("sha256").update(job.id).digest("hex").slice(0, 32),
    }))
  const jobs: Job[] = initial()
  let next = 120
  return createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" })
      res.end(JSON.stringify(body))
    }
    if (req.headers.authorization !== `Bearer ${token}`)
      return send(401, { error: "Unauthorized" })
    const url = new URL(req.url ?? "/", "http://fixture")
    if (req.method === "POST" && url.pathname === "/internal/reset") {
      jobs.splice(0, jobs.length, ...initial())
      next = 120
      return send(200, { ok: true })
    }
    if (req.method === "GET" && url.pathname === "/internal/printers")
      return send(200, {
        printers: [
          {
            id: "document",
            state: jobs.some(
              (j) => j.printer === "document" && j.state === "processing"
            )
              ? "busy"
              : "idle",
            status: {
              printer_state_message: "Printing page 7 of 24",
              reasons: ["none"],
              queried_at: minutes(0.2),
            },
            last_job:
              jobs.find(
                (j) =>
                  j.printer === "document" &&
                  !j.dry_run &&
                  !["pending", "processing"].includes(j.state)
              ) ?? null,
          },
          {
            id: "receipt",
            state: "idle",
            status: { reasons: [], queried_at: minutes(0.2) },
            last_job:
              jobs.find(
                (j) =>
                  j.printer === "receipt" &&
                  !j.dry_run &&
                  !["pending", "processing"].includes(j.state)
              ) ?? null,
          },
        ],
      })
    if (req.method === "GET" && url.pathname === "/internal/jobs")
      return send(200, {
        jobs,
        cups: {
          document: "document-118\ndocument-119",
          receipt: "",
        },
      })
    if (req.method === "GET" && url.pathname === "/internal/stats")
      return send(200, stats())
    const cancel = /^\/internal\/jobs\/([^/]+)\/cancel$/.exec(url.pathname)
    if (req.method === "POST" && cancel) {
      const job = jobs.find((j) => j.id === decodeURIComponent(cancel[1]))
      if (!job) return send(404, { error: "Unknown job" })
      job.state = "canceled"
      return send(200, { cancelled: job.id })
    }
    if (req.method === "POST" && url.pathname === "/internal/jobs") {
      const form = await new Request("http://fixture", {
        method: "POST",
        headers: { "Content-Type": req.headers["content-type"] ?? "" },
        body: req as unknown as ReadableStream,
        duplex: "half",
      } as RequestInit).formData()
      if (form.get("dry_run") !== "true")
        return send(422, { error: "The fixture core only accepts dry runs" })
      const printer = form.get("printer") === "receipt" ? "receipt" : "document"
      const job: Job = {
        id: createHash("sha256")
          .update(`${printer}-${next++}`)
          .digest("hex")
          .slice(0, 32),
        cups_id: null,
        printer,
        source: "web",
        state: "completed",
        pages: printer === "receipt" ? 1 : 2,
        copies: Number(form.get("copies") || 1),
        created_at: new Date().toISOString(),
        dry_run: true,
      }
      jobs.unshift(job)
      return send(201, { job })
    }
    send(404, { error: "Not found" })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const token = process.env.PRINT_CORE_TOKEN
  if (!token) throw Error("Set PRINT_CORE_TOKEN for the fixture core")
  const port = Number(process.env.FIXTURE_PORT || 8772)
  createFixtureCore(token).listen(port, "127.0.0.1", () =>
    console.log(`Fixture core on http://127.0.0.1:${port}`)
  )
}
