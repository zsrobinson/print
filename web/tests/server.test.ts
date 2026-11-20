import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, test } from "node:test"
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose"
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
let coreReply: (request: Seen) => { status: number; body: string } = () => ({
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
      const { status, body } = coreReply(request)
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Set-Cookie": "core=secret",
        "X-Core-Internal": "1",
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
