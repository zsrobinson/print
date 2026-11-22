import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose"
import { serve } from "@zsrobinson/shell/server"
import { createPrintServer } from "../server/app"
import { coreOrigin, loadConfig } from "../server/config"

type Seen = {
  method: string
  url: string
  headers: IncomingMessage["headers"]
  body: Buffer
}
let dir: string
let issuer: string
let privateKey: CryptoKey
let certs: Server
let core: Server
let coreUrl: string
const seen: Seen[] = []
type CoreAnswer = {
  status: number
  body: string | Buffer
  headers?: Record<string, string>
}
let coreReply: (request: Seen) => CoreAnswer = () => ({
  status: 200,
  body: "{}",
})
const logs: unknown[] = []
const ORIGIN = "https://print.example.test"
const CORE_TOKEN = "test-only-core-token"
const METRICS_TOKEN = "test-only-metrics-token"
const PDF = Buffer.concat([
  Buffer.from("%PDF-1.7\n"),
  Buffer.from([0, 1, 2, 255, 254, 13, 10]),
  Buffer.from("\n%%EOF\n"),
])

const listen = (server: Server) =>
  new Promise<string>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve("http://127.0.0.1:" + (server.address() as { port: number }).port)
    )
  )

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "print-web-test-"))
  await mkdir(join(dir, "dist", "assets"), { recursive: true })
  await writeFile(join(dir, "dist", "index.html"), "<!doctype html><p>app")
  await writeFile(join(dir, "dist", "assets", "index-abc123.js"), "void 0")
  await writeFile(
    join(dir, "services.json"),
    JSON.stringify([{ name: "Other", url: "https://other.example.test" }])
  )
  const keys = await generateKeyPair("RS256")
  privateKey = keys.privateKey
  const jwk = {
    ...(await exportJWK(keys.publicKey)),
    kid: "test-key",
    alg: "RS256",
  }
  certs = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ keys: [jwk] }))
  })
  issuer = await listen(certs)
  core = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      const request = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks),
      }
      seen.push(request)
      const { status, body, headers } = coreReply(request)
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Set-Cookie": "core=secret",
        "X-Core-Internal": "1",
        ...headers,
      })
      res.end(body)
    })
  })
  coreUrl = await listen(core)
})

after(async () => {
  await new Promise((r) => certs.close(r))
  await new Promise((r) => core.close(r))
  await rm(dir, { recursive: true, force: true })
})

function app() {
  return createPrintServer({
    config: {
      issuer,
      audience: "test-audience",
      publicOrigin: ORIGIN,
      serviceManifest: join(dir, "services.json"),
      coreOrigin: coreUrl,
      coreToken: CORE_TOKEN,
      metricsToken: METRICS_TOKEN,
    },
    staticRoot: join(dir, "dist"),
    log: (metadata) => logs.push(metadata),
  })
}

async function token({
  audience = "test-audience",
  iss = issuer,
  expires = "5m",
  email = "operator@example.test" as string | null,
} = {}) {
  return new SignJWT(email ? { email } : {})
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(iss)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expires)
    .sign(privateKey)
}

async function call(
  path: string,
  init: RequestInit & { auth?: boolean | string; origin?: string | null } = {}
) {
  const headers = new Headers(init.headers)
  if (init.auth !== false)
    headers.set(
      "Cf-Access-Jwt-Assertion",
      typeof init.auth === "string" ? init.auth : await token()
    )
  const origin = init.origin === undefined ? ORIGIN : init.origin
  if (init.method && init.method !== "GET" && origin !== null)
    headers.set("Origin", origin)
  return app().fetch(
    new Request("http://print.local" + path, { ...init, headers })
  )
}

function documentForm(
  fields: Record<string, string> = {},
  file: Blob = new Blob([PDF])
) {
  const form = new FormData()
  form.set("printer", "document")
  form.set("file", file, "Quarterly report – private.pdf")
  form.set("dry_run", "true")
  for (const [key, value] of Object.entries(fields)) form.set(key, value)
  return form
}

/** Pull one named part out of a multipart body the core received. */
function part(request: Seen, name: string) {
  const boundary = /boundary=(.+)$/.exec(
    String(request.headers["content-type"])
  )![1]
  const raw = request.body.toString("latin1")
  for (const section of raw.split("--" + boundary)) {
    const [head, ...rest] = section.split("\r\n\r\n")
    if (head.includes(`name="${name}"`))
      return {
        head,
        body: Buffer.from(rest.join("\r\n\r\n").replace(/\r\n$/, ""), "latin1"),
      }
  }
  return null
}

test("every page, asset and API route requires a valid Access assertion", async () => {
  for (const path of [
    "/",
    "/index.html",
    "/assets/index-abc123.js",
    "/queue",
    "/api/session",
    "/api/printers",
    "/api/jobs",
    "/api/stats",
    "/api/printers/document",
    "/api/jobs/document-1",
    "/api/jobs/document-1/file",
    "/api/missing",
    "/favicon.ico",
  ]) {
    const response = await call(path, { auth: false })
    assert.equal(response.status, 401, path)
    assert.doesNotMatch(await response.text(), /app|void 0/, path)
  }
  for (const auth of [
    await token({ audience: "other" }),
    await token({ iss: "https://attacker.example.test" }),
    await token({ expires: "-1m" }),
    await token({ email: null }),
    "not-a-jwt",
  ])
    assert.equal((await call("/", { auth })).status, 401)
  const upload = await call("/api/jobs", {
    method: "POST",
    body: documentForm(),
    auth: false,
  })
  assert.equal(upload.status, 401)
  for (const path of ["/api/fetch", "/api/printers/document/check"])
    assert.equal(
      (await call(path, { method: "POST", auth: false })).status,
      401
    )
  assert.equal(seen.length, 0, "unauthenticated requests never reach the core")

  const page = await call("/")
  assert.equal(page.status, 200)
  assert.match(await page.text(), /app/)
  assert.equal(page.headers.get("Cache-Control"), "no-cache")
  assert.match(
    page.headers.get("Content-Security-Policy") ?? "",
    /default-src 'self'/
  )
  const asset = await call("/assets/index-abc123.js")
  assert.equal(asset.status, 200)
  assert.match(asset.headers.get("Cache-Control") ?? "", /immutable/)
  const session = await (await call("/api/session")).json()
  assert.equal(session.email, "operator@example.test")
  assert.equal(session.services[0].name, "Other")
})

test("mutations from another Origin are rejected before the core", async () => {
  seen.length = 0
  for (const origin of ["https://evil.example.test", "null", ""]) {
    const response = await call("/api/jobs", {
      method: "POST",
      body: documentForm(),
      origin: origin || null,
    })
    assert.equal(response.status, 403, origin || "no origin")
    const cancel = await call("/api/jobs/document-1/cancel", {
      method: "POST",
      origin: origin || null,
    })
    assert.equal(cancel.status, 403)
    const check = await call("/api/printers/document/check", {
      method: "POST",
      origin: origin || null,
    })
    assert.equal(check.status, 403)
    const link = await call("/api/fetch", {
      method: "POST",
      origin: origin || null,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/a.pdf" }),
    })
    assert.equal(link.status, 403)
  }
  assert.equal(seen.length, 0)
})

test("reads are proxied with the server token and nothing from the browser", async () => {
  seen.length = 0
  const printers = {
    printers: [
      { id: "document", state: "idle", status: {}, last_job: null },
      { id: "receipt", state: "offline", status: {}, last_job: null },
    ],
  }
  coreReply = () => ({ status: 200, body: JSON.stringify(printers) })
  const response = await call("/api/printers?debug=1&queue=x", {
    headers: {
      Authorization: "Bearer browser-supplied",
      Cookie: "CF_Authorization=browser-cookie",
      "X-Forwarded-For": "203.0.113.9",
    },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), printers)
  assert.equal(response.headers.get("Cache-Control"), "no-store")
  assert.equal(response.headers.get("Set-Cookie"), null)
  assert.equal(response.headers.get("X-Core-Internal"), null)
  const [request] = seen
  assert.equal(request.method, "GET")
  assert.equal(request.url, "/internal/printers")
  assert.equal(request.headers.authorization, `Bearer ${CORE_TOKEN}`)
  assert.equal(request.headers.cookie, undefined)
  assert.equal(request.headers["cf-access-jwt-assertion"], undefined)
  assert.equal(request.headers["x-forwarded-for"], undefined)

  for (const resource of ["jobs", "stats"]) {
    seen.length = 0
    coreReply = () => ({ status: 200, body: `{"${resource}":[]}` })
    const reply = await call(`/api/${resource}`)
    assert.equal(reply.status, 200)
    assert.equal(seen[0].url, `/internal/${resource}`)
  }
})

test("documents reach the core as original bytes and allow-listed fields", async () => {
  seen.length = 0
  coreReply = () => ({
    status: 201,
    body: JSON.stringify({ job: { id: "document-7", dry_run: true } }),
  })
  const response = await call("/api/jobs", {
    method: "POST",
    body: documentForm({
      copies: "3",
      duplex: "two-sided-long-edge",
      page_range: " 1-2,4 ",
      token: "smuggled",
      queue: "elsewhere",
    }),
  })
  assert.equal(response.status, 201)
  assert.equal((await response.json()).job.id, "document-7")
  const [request] = seen
  assert.equal(request.url, "/internal/jobs")
  assert.equal(request.headers.authorization, `Bearer ${CORE_TOKEN}`)
  const file = part(request, "file")!
  assert.equal(
    createHash("sha256").update(file.body).digest("hex"),
    createHash("sha256").update(PDF).digest("hex")
  )
  assert.match(file.head, /filename="document.pdf"/)
  assert.match(file.head, /Content-Type: application\/pdf/)
  assert.doesNotMatch(
    request.body.toString("latin1"),
    /Quarterly|smuggled|elsewhere/
  )
  assert.equal(part(request, "copies")!.body.toString(), "3")
  assert.equal(part(request, "duplex")!.body.toString(), "two-sided-long-edge")
  assert.equal(part(request, "page_range")!.body.toString(), "1-2,4")
  assert.equal(part(request, "dry_run")!.body.toString(), "true")
  assert.equal(part(request, "printer")!.body.toString(), "document")
  assert.equal(part(request, "token"), null)

  seen.length = 0
  const png = new Blob([Buffer.from("89504e470d0a1a0a0000", "hex")], {
    type: "application/pdf",
  })
  await call("/api/jobs", { method: "POST", body: documentForm({}, png) })
  const image = part(seen[0], "file")!
  assert.match(image.head, /Content-Type: image\/png/)
  assert.equal(part(seen[0], "copies")!.body.toString(), "1")
  assert.equal(part(seen[0], "duplex")!.body.toString(), "one-sided")
})

test("receipts carry text only, with line breaks as typed", async () => {
  seen.length = 0
  coreReply = () => ({ status: 200, body: '{"job":{"id":"receipt-2"}}' })
  const form = new FormData()
  form.set("printer", "receipt")
  form.set("text", "# Title\r\n- [ ] one")
  form.set("dry_run", "true")
  const response = await call("/api/jobs", { method: "POST", body: form })
  assert.equal(response.status, 200)
  assert.equal(part(seen[0], "text")!.body.toString(), "# Title\r\n- [ ] one")
  assert.equal(part(seen[0], "file"), null)
  assert.equal(part(seen[0], "copies"), null)
})

test("invalid jobs are refused without reaching the core", async () => {
  seen.length = 0
  const receipt = (text: string, extra?: (form: FormData) => void) => {
    const form = new FormData()
    form.set("printer", "receipt")
    form.set("text", text)
    extra?.(form)
    return form
  }
  const cases: [FormData | string, number][] = [
    [documentForm({ printer: "laser" }), 400],
    [documentForm({ copies: "0" }), 400],
    [documentForm({ copies: "101" }), 400],
    [documentForm({ copies: "1.5" }), 400],
    [documentForm({ duplex: "sideways" }), 400],
    [documentForm({ page_range: "3-1" }), 400],
    [documentForm({ page_range: "1;lp -d other" }), 400],
    [documentForm({ dry_run: "yes" }), 400],
    [documentForm({}, new Blob(["<html>not a pdf"])), 415],
    [documentForm({}, new Blob([])), 400],
    [
      documentForm(
        { page_range: "1" },
        new Blob([Buffer.from("ffd8ffe000", "hex")])
      ),
      400,
    ],
    [
      (() => {
        const form = documentForm()
        form.append("copies", "2")
        form.append("copies", "3")
        return form
      })(),
      400,
    ],
    [receipt("   "), 400],
    [receipt("x".repeat(10_001)), 413],
    [receipt("ok", (form) => form.set("file", new Blob([PDF]))), 400],
    ["printer=document", 415],
  ]
  for (const [body, status] of cases) {
    const response = await call("/api/jobs", {
      method: "POST",
      body,
      headers:
        typeof body === "string"
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : {},
    })
    assert.equal(response.status, status, JSON.stringify(await response.json()))
  }
  assert.equal(seen.length, 0)
})

test("uploads over the limit are cut off at the body limit", async () => {
  seen.length = 0
  const big = new Blob([PDF, new Uint8Array(10 * 1024 * 1024 + 1)])
  const response = await call("/api/jobs", {
    method: "POST",
    body: documentForm({}, big),
  })
  assert.equal(response.status, 413)
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(11 * 1024 * 1024))
      controller.close()
    },
  })
  const chunked = await call("/api/jobs", {
    method: "POST",
    body: stream,
    headers: { "Content-Type": "multipart/form-data; boundary=x" },
    duplex: "half",
  } as RequestInit)
  assert.equal(chunked.status, 413)
  assert.equal(seen.length, 0)
})

test("cancel validates the job id and forwards one request", async () => {
  seen.length = 0
  coreReply = () => ({ status: 200, body: '{"cancelled":"document-12"}' })
  const ok = await call("/api/jobs/document-12/cancel", { method: "POST" })
  assert.equal(ok.status, 200)
  assert.equal(seen[0].method, "POST")
  assert.equal(seen[0].url, "/internal/jobs/document-12/cancel")
  for (const id of [
    "..%2F..%2Finternal%2Fstats",
    "a%20b",
    "-1",
    "x".repeat(129),
  ]) {
    const response = await call(`/api/jobs/${id}/cancel`, { method: "POST" })
    assert.ok([400, 404].includes(response.status), id)
  }
  assert.equal(seen.length, 1)
})

test("core failures map to bounded errors without internal detail", async () => {
  coreReply = () => ({
    status: 500,
    body: JSON.stringify({ error: "Traceback: /srv/print/server.py line 9" }),
  })
  let response = await call("/api/jobs")
  assert.equal(response.status, 502)
  assert.deepEqual(await response.json(), {
    error: "Print service unavailable",
  })

  coreReply = () => ({ status: 401, body: '{"error":"bad token"}' })
  response = await call("/api/printers")
  assert.equal(response.status, 502, "a core auth failure is not the viewer's")

  coreReply = () => ({
    status: 422,
    body: JSON.stringify({
      error: "Page range outside document\u0007" + "x".repeat(400),
    }),
  })
  response = await call("/api/jobs", { method: "POST", body: documentForm() })
  assert.equal(response.status, 422)
  const { error } = await response.json()
  assert.match(error, /^Page range outside document/)
  assert.ok(error.length <= 300)

  coreReply = () => ({ status: 200, body: "<html>proxy page" })
  response = await call("/api/stats")
  assert.equal(response.status, 502)

  const closed = createPrintServer({
    config: {
      issuer,
      audience: "test-audience",
      publicOrigin: ORIGIN,
      serviceManifest: join(dir, "missing.json"),
      coreOrigin: "http://127.0.0.1:9",
      coreToken: CORE_TOKEN,
    },
    staticRoot: join(dir, "dist"),
    log: () => {},
  })
  const down = await closed.fetch(
    new Request("http://print.local/api/printers", {
      headers: { "Cf-Access-Jwt-Assertion": await token() },
    })
  )
  assert.equal(down.status, 502)
  const session = await closed.fetch(
    new Request("http://print.local/api/session", {
      headers: { "Cf-Access-Jwt-Assertion": await token() },
    })
  )
  assert.deepEqual((await session.json()).services, [])
  const metrics = await closed.fetch(new Request("http://print.local/metrics"))
  assert.equal(metrics.status, 403, "metrics stay closed without a token")
})

test("metrics need their own token and logs hold only metadata", async () => {
  logs.length = 0
  coreReply = () => ({ status: 200, body: '{"jobs":[]}' })
  await call("/api/jobs?email=operator@example.test")
  await call("/api/jobs/document-12/cancel", { method: "POST" })
  for (const entry of logs) {
    assert.deepEqual(Object.keys(entry as object).sort(), [
      "durationMs",
      "method",
      "route",
      "status",
    ])
    assert.doesNotMatch(JSON.stringify(entry), /operator|document-12|token/)
  }
  assert.ok(
    logs.some(
      (entry) => (entry as { route: string }).route === "/api/jobs/:id/cancel"
    )
  )
  const server = app()
  assert.equal(
    (await server.fetch(new Request("http://print.local/metrics"))).status,
    403
  )
  const wrong = await server.fetch(
    new Request("http://print.local/metrics", {
      headers: { Authorization: `Bearer ${CORE_TOKEN}` },
    })
  )
  assert.equal(wrong.status, 403)
  const metrics = await server.fetch(
    new Request("http://print.local/metrics", {
      headers: { Authorization: `Bearer ${METRICS_TOKEN}` },
    })
  )
  assert.equal(metrics.status, 200)
  assert.doesNotMatch(await metrics.text(), /operator|document-12|email/)
  const viaMetricsToken = await call("/api/jobs", {
    auth: false,
    headers: { Authorization: `Bearer ${METRICS_TOKEN}` },
  })
  assert.equal(viaMetricsToken.status, 401)
})

test("the core token may only travel to a loopback origin", () => {
  assert.equal(coreOrigin("http://127.0.0.1:8765"), "http://127.0.0.1:8765")
  assert.equal(coreOrigin("http://localhost:8765/"), "http://localhost:8765")
  assert.equal(coreOrigin("http://[::1]:8765"), "http://[::1]:8765")
  for (const value of [
    "http://print.example.test:8765",
    "http://10.0.0.5:8765",
    "http://127.0.0.1.example.test",
    "http://user:pass@127.0.0.1:8765",
    "http://127.0.0.1:8765/internal",
    "file:///etc/passwd",
    "127.0.0.1:8765",
  ])
    assert.throws(() => coreOrigin(value), /PRINT_CORE_URL/, value)
  const env = {
    ACCESS_ISSUER: "https://team.example.test",
    ACCESS_AUD: "aud",
    PUBLIC_ORIGIN: ORIGIN,
    SERVICE_MANIFEST: "/dev/null",
  }
  assert.throws(() => loadConfig(env), /PRINT_CORE_TOKEN/)
  const config = loadConfig({ ...env, PRINT_CORE_TOKEN: "t" })
  assert.equal(config.coreOrigin, "http://127.0.0.1:8772")
  assert.equal(config.bindAddress, "127.0.0.1")
  assert.throws(() =>
    loadConfig({
      ...env,
      PRINT_CORE_TOKEN: "t",
      PRINT_CORE_URL: "http://example.test",
    })
  )
})

const json = (body: unknown): CoreAnswer => ({
  status: 200,
  body: JSON.stringify(body),
})

test("job listings rebuild the query from validated values only", async () => {
  coreReply = () => json({ jobs: [], total: 0 })
  seen.length = 0
  const ok = await call(
    "/api/jobs?q=%20Lease%20100%25_%20&printer=document&status=failed&source=mcp&dry_run=false&from=2026-01-01&to=2026-01-31&limit=50&offset=100&token=x&queue=other&cups=1"
  )
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { jobs: [], total: 0 })
  const forwarded = new URL(seen[0].url, "http://core")
  assert.equal(forwarded.pathname, "/internal/jobs")
  assert.deepEqual(
    [...forwarded.searchParams],
    [
      ["q", "Lease 100%_"],
      ["printer", "document"],
      ["status", "failed"],
      ["source", "mcp"],
      ["dry_run", "false"],
      ["from", "2026-01-01"],
      ["to", "2026-01-31"],
      ["limit", "50"],
      ["offset", "100"],
    ]
  )

  for (const status of [
    "active",
    "finished",
    "completed",
    "failed",
    "canceled",
  ]) {
    seen.length = 0
    assert.equal((await call(`/api/jobs?status=${status}`)).status, 200)
    assert.equal(seen[0].url, `/internal/jobs?status=${status}`)
  }

  seen.length = 0
  await call("/api/jobs?q=&printer=&limit=1&offset=0")
  assert.equal(seen[0].url, "/internal/jobs?limit=1&offset=0")

  seen.length = 0
  for (const query of [
    "q=" + "x".repeat(101),
    "q=a%00b",
    "printer=laser",
    "printer=document&printer=receipt",
    "status=aborted",
    "status=ACTIVE",
    "source=cli",
    "dry_run=1",
    "from=2026-02-30",
    "from=2026-1-1",
    "to=yesterday",
    "from=2026-02-02&to=2026-02-01",
    "limit=0",
    "limit=101",
    "limit=-1",
    "limit=1e2",
    "offset=100001",
    "offset=01",
    "offset=1.5",
  ]) {
    const response = await call(`/api/jobs?${query}`)
    assert.equal(response.status, 400, query)
    assert.equal(typeof (await response.json()).error, "string")
  }
  assert.equal(seen.length, 0, "invalid listings never reach the core")
})

test("stats ranges are allow-listed", async () => {
  coreReply = () => json({ range: "7d" })
  for (const range of ["7d", "30d", "90d", "all"]) {
    seen.length = 0
    const response = await call(`/api/stats?range=${range}&debug=1`)
    assert.equal(response.status, 200)
    assert.equal(seen[0].url, `/internal/stats?range=${range}`)
  }
  seen.length = 0
  for (const range of ["1y", "7D", "all&range=7d", "%2e%2e"])
    assert.equal((await call(`/api/stats?range=${range}`)).status, 400, range)
  assert.equal(seen.length, 0)
})

test("printer detail and checks accept the two printers only", async () => {
  coreReply = () => json({ printer: { id: "receipt", history: [] } })
  seen.length = 0
  const detail = await call("/api/printers/receipt?queue=other", {
    headers: { Cookie: "a=b" },
  })
  assert.equal(detail.status, 200)
  assert.equal((await detail.json()).printer.id, "receipt")
  assert.equal(detail.headers.get("Set-Cookie"), null)
  assert.equal(seen[0].method, "GET")
  assert.equal(seen[0].url, "/internal/printers/receipt")
  assert.equal(seen[0].headers.cookie, undefined)

  seen.length = 0
  coreReply = () => json({ printer: "document", ok: true, checks: [] })
  const check = await call("/api/printers/document/check", { method: "POST" })
  assert.equal(check.status, 200)
  assert.equal(seen[0].method, "POST")
  assert.equal(seen[0].url, "/internal/printers/document/check")
  assert.equal(seen[0].body.length, 0, "a check sends no body")

  seen.length = 0
  for (const id of ["laser", "DOCUMENT", "..%2Fjobs", "document%2Fcheck"]) {
    assert.equal((await call(`/api/printers/${id}`)).status, 404, id)
    const response = await call(`/api/printers/${id}/check`, {
      method: "POST",
    })
    assert.equal(response.status, 404, id)
  }
  assert.equal(seen.length, 0)
})

test("job detail validates the id and relays the core's answer", async () => {
  coreReply = () => json({ job: { id: "abc123", events: [] } })
  seen.length = 0
  const ok = await call("/api/jobs/abc123")
  assert.equal(ok.status, 200)
  assert.equal(seen[0].url, "/internal/jobs/abc123")
  coreReply = () => ({ status: 404, body: '{"error":"Unknown job"}' })
  const missing = await call("/api/jobs/zzz")
  assert.equal(missing.status, 404)
  assert.deepEqual(await missing.json(), { error: "Unknown job" })
  seen.length = 0
  for (const id of ["a%20b", "-1", "x".repeat(129), "..%2F..%2Fstats"])
    assert.ok([400, 404].includes((await call(`/api/jobs/${id}`)).status), id)
  assert.equal(seen.length, 0)
})

test("kept files pass through as allow-listed bytes without core headers", async () => {
  const png = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    Buffer.from([0, 255, 13, 10]),
  ])
  const cases: [string, Buffer, string, string][] = [
    ["application/pdf", PDF, "application/pdf", "document.pdf"],
    ["image/png", png, "image/png", "image.png"],
    ["image/jpeg", Buffer.from("ffd8ffe0", "hex"), "image/jpeg", "image.jpg"],
    [
      "text/plain; charset=utf-8",
      Buffer.from("# Groceries\n- [ ] Lemons ✓\n"),
      "text/plain; charset=utf-8",
      "receipt.txt",
    ],
    [
      "Text/Plain",
      Buffer.from("plain"),
      "text/plain; charset=utf-8",
      "receipt.txt",
    ],
  ]
  for (const [declared, bytes, type, name] of cases) {
    seen.length = 0
    coreReply = () => ({
      status: 200,
      body: bytes,
      headers: {
        "Content-Type": declared,
        "Content-Disposition": 'inline; filename="Lease renewal.pdf"',
        ETag: '"core"',
      },
    })
    const response = await call("/api/jobs/abc123/file", {
      headers: { Range: "bytes=0-1", Authorization: "Bearer browser" },
    })
    assert.equal(response.status, 200, declared)
    assert.equal(response.headers.get("Content-Type"), type)
    assert.equal(response.headers.get("Cache-Control"), "no-store")
    assert.equal(
      response.headers.get("Content-Disposition"),
      `attachment; filename="${name}"`
    )
    assert.equal(response.headers.get("Set-Cookie"), null)
    assert.equal(response.headers.get("X-Core-Internal"), null)
    assert.equal(response.headers.get("ETag"), null)
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff")
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
    assert.equal(seen[0].url, "/internal/jobs/abc123/file")
    assert.equal(seen[0].headers.authorization, `Bearer ${CORE_TOKEN}`)
    assert.equal(seen[0].headers.range, undefined)
  }

  for (const [declared, bytes] of [
    ["text/html", Buffer.from("<script>alert(1)</script>")],
    ["image/svg+xml", Buffer.from("<svg/>")],
    ["application/octet-stream", PDF],
    ["text/plain; charset=latin1", Buffer.from("x")],
    ["text/plain", Buffer.from([0xff, 0xfe, 0x00])],
    ["application/pdf", Buffer.from("<html>not a pdf")],
    ["image/png", PDF],
    ["application/json", Buffer.from('{"job":1}')],
  ] as const) {
    coreReply = () => ({
      status: 200,
      body: bytes,
      headers: { "Content-Type": declared },
    })
    const response = await call("/api/jobs/abc123/file")
    assert.equal(response.status, 502, declared)
    assert.match(response.headers.get("Content-Type") ?? "", /json/)
  }

  coreReply = () => ({
    status: 200,
    body: Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024 + 64 * 1024)]),
    headers: { "Content-Type": "application/pdf" },
  })
  assert.equal((await call("/api/jobs/abc123/file")).status, 502, "too large")

  coreReply = () => ({
    status: 404,
    body: '{"error":"The kept copy has expired"}',
  })
  const expired = await call("/api/jobs/abc123/file")
  assert.equal(expired.status, 404)
  assert.deepEqual(await expired.json(), {
    error: "The kept copy has expired",
  })
  coreReply = () => ({ status: 500, body: "Traceback /srv/kept/abc123" })
  const broken = await call("/api/jobs/abc123/file")
  assert.equal(broken.status, 502)
  assert.doesNotMatch(await broken.text(), /Traceback|srv/)
})

test("link fetches send one validated https URL as a form", async () => {
  coreReply = () => ({
    status: 200,
    body: PDF,
    headers: { "Content-Type": "application/pdf", "X-Upstream": "1" },
  })
  seen.length = 0
  const response = await call("/api/fetch", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: "a=b" },
    body: JSON.stringify({
      url: "https://example.com/papers/whitepaper-v2.pdf?v=2#page=3",
      printer: "receipt",
    }),
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("Content-Type"), "application/pdf")
  assert.equal(response.headers.get("X-Upstream"), null)
  assert.equal(response.headers.get("Cache-Control"), "no-store")
  assert.match(response.headers.get("Content-Disposition") ?? "", /^attachment/)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PDF)
  const [request] = seen
  assert.equal(request.method, "POST")
  assert.equal(request.url, "/internal/fetch")
  assert.equal(request.headers.cookie, undefined)
  assert.equal(
    part(request, "url")!.body.toString(),
    "https://example.com/papers/whitepaper-v2.pdf?v=2"
  )
  assert.equal(part(request, "printer"), null)

  seen.length = 0
  const form = new FormData()
  form.set("url", "https://example.com/a.pdf")
  assert.equal(
    (await call("/api/fetch", { method: "POST", body: form })).status,
    200
  )
  assert.equal(
    part(seen[0], "url")!.body.toString(),
    "https://example.com/a.pdf"
  )

  seen.length = 0
  for (const url of [
    "http://example.com/a.pdf",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://user:pass@example.com/a.pdf",
    "https://token@example.com/a.pdf",
    "not a url",
    "",
    "https://example.com/" + "a".repeat(2048),
    42,
    null,
  ]) {
    const reply = await call("/api/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    })
    assert.equal(reply.status, 400, String(url))
    assert.doesNotMatch(
      JSON.stringify(await reply.json()),
      /example\.com|passwd|user:pass/,
      "errors never echo the link"
    )
  }
  for (const [body, type, status] of [
    ["{", "application/json", 400],
    ["[]", "application/json", 400],
    ["https://example.com/a.pdf", "text/plain", 415],
    ["x".repeat(9 * 1024), "application/json", 413],
  ] as const) {
    const reply = await call("/api/fetch", {
      method: "POST",
      headers: { "Content-Type": type },
      body,
    })
    assert.equal(reply.status, status, `${type} ${body.slice(0, 10)}`)
  }
  assert.equal(seen.length, 0)

  coreReply = () => ({
    status: 400,
    body: '{"error":"That link did not return a PDF"}',
  })
  const refused = await call("/api/fetch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://example.com/page" }),
  })
  assert.equal(refused.status, 400)
  assert.deepEqual(await refused.json(), {
    error: "That link did not return a PDF",
  })
  coreReply = () => ({
    status: 413,
    body: '{"error":"Linked PDFs can be up to 10 MiB here"}',
  })
  const large = await call("/api/fetch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://example.com/big.pdf" }),
  })
  assert.equal(large.status, 413)
  for (const [declared, bytes] of [
    ["image/png", Buffer.from("89504e470d0a1a0a", "hex")],
    ["text/plain; charset=utf-8", Buffer.from("hello")],
  ] as const) {
    coreReply = () => ({
      status: 200,
      body: bytes,
      headers: { "Content-Type": declared },
    })
    const reply = await call("/api/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/a.pdf" }),
    })
    assert.equal(reply.status, 502, `fetch only returns PDFs, not ${declared}`)
  }
})

test("job names are sanitised and sent apart from the file", async () => {
  coreReply = () => ({ status: 201, body: '{"job":{"id":"document-8"}}' })
  const cases: [string, string | null][] = [
    ["Lease renewal.pdf", "Lease renewal.pdf"],
    ["  Boarding pass –\tLisbon.pdf \r\n", "Boarding pass – Lisbon.pdf"],
    ["a\u0000b\u0007c‮d​e", "a b c d e"],
    ["\u0000\u0001  \t", null],
    ["", null],
    ["é".repeat(130), "é".repeat(120)],
    ["😀".repeat(121), "😀".repeat(120)],
  ]
  for (const [name, expected] of cases) {
    seen.length = 0
    const response = await call("/api/jobs", {
      method: "POST",
      body: documentForm({ name }),
    })
    assert.equal(response.status, 201, JSON.stringify(name))
    const sent = part(seen[0], "name")
    assert.equal(
      sent ? sent.body.toString("utf8") : null,
      expected,
      JSON.stringify(name)
    )
    assert.match(part(seen[0], "file")!.head, /filename="document.pdf"/)
  }

  seen.length = 0
  const receipt = new FormData()
  receipt.set("printer", "receipt")
  receipt.set("text", "Groceries\n- milk")
  receipt.set("name", "Groceries")
  await call("/api/jobs", { method: "POST", body: receipt })
  assert.equal(part(seen[0], "name")!.body.toString(), "Groceries")

  seen.length = 0
  const twice = documentForm()
  twice.append("name", "one")
  twice.append("name", "two")
  const asFile = documentForm()
  asFile.set("name", new Blob(["x"]), "x.txt")
  for (const body of [twice, asFile])
    assert.equal(
      (await call("/api/jobs", { method: "POST", body })).status,
      400
    )
  assert.equal(seen.length, 0)
})

test("new routes log route patterns, never names, ids or links", async () => {
  logs.length = 0
  coreReply = () => ({
    status: 200,
    body: PDF,
    headers: { "Content-Type": "application/pdf" },
  })
  await call("/api/jobs/secretjob42/file")
  await call("/api/fetch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://example.com/private-plan.pdf" }),
  })
  coreReply = () => json({ jobs: [], total: 0 })
  await call("/api/jobs?q=Lease%20renewal")
  await call("/api/printers/receipt")
  const text = JSON.stringify(logs)
  assert.doesNotMatch(text, /secretjob42|private-plan|example\.com|Lease/)
  const routes = logs.map((entry) => (entry as { route: string }).route)
  for (const route of [
    "/api/jobs/:id/file",
    "/api/fetch",
    "/api/jobs",
    "/api/printers/:id",
  ])
    assert.ok(routes.includes(route), route)
})

test("replies survive the Node adapter's own Response class", async () => {
  // serve() swaps the global Response, as it does in production.
  const server = await new Promise<Server>((resolve) => {
    const started: Server = serve(
      { fetch: app().fetch, hostname: "127.0.0.1", port: 0 },
      () => resolve(started)
    ) as Server
  })
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const headers = { "Cf-Access-Jwt-Assertion": await token() }
    coreReply = () => json({ printers: [{ id: "document" }] })
    const printers = await fetch(`${base}/api/printers`, { headers })
    assert.deepEqual(await printers.json(), { printers: [{ id: "document" }] })
    coreReply = () => ({
      status: 200,
      body: PDF,
      headers: { "Content-Type": "application/pdf" },
    })
    const file = await fetch(`${base}/api/jobs/abc123/file`, { headers })
    assert.equal(file.status, 200)
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), PDF)
  } finally {
    await new Promise((r) => server.close(r))
  }
})
