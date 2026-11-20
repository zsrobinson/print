/**
 * Screenshot every page against the fixture core, at desktop and phone widths
 * in light and dark. Everything binds to loopback; Access is satisfied by a
 * throwaway key generated for this run, and the fixture core accepts only dry
 * runs, so nothing can reach a printer.
 *
 *   npm run build && npm run capture            # writes captures/*.png
 *   npm run capture -- --serve                  # also keep a header-adding
 *                                               # loopback proxy for a browser
 */
import { mkdir } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { join } from "node:path"
import { serve } from "@hono/node-server"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import { chromium, type Page } from "@playwright/test"
import { createPrintServer } from "../server/app"
import { createFixtureCore } from "./fixture-core"

const OUT = process.env.CAPTURE_DIR || "captures"
const SERVE = process.argv.includes("--serve")
const AUDIENCE = "capture-audience"
const CORE_TOKEN = "capture-only-core-token"

const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as { port: number }).port)
    )
  )

const { publicKey, privateKey } = await generateKeyPair("RS256")
const jwk = { ...(await exportJWK(publicKey)), kid: "capture", alg: "RS256" }
const certs = createServer((_req, res) => {
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify({ keys: [jwk] }))
})
const issuer = `http://127.0.0.1:${await listen(certs)}`
const core = createFixtureCore(CORE_TOKEN)
const corePort = await listen(core)

const webPort = await new Promise<number>((resolve) => {
  const placeholder = createServer()
  placeholder.listen(0, "127.0.0.1", () => {
    const { port } = placeholder.address() as { port: number }
    placeholder.close(() => resolve(port))
  })
})
const origin = `http://127.0.0.1:${webPort}`
const app = createPrintServer({
  config: {
    issuer,
    audience: AUDIENCE,
    publicOrigin: origin,
    serviceManifest: join(import.meta.dirname, "capture-services.json"),
    coreOrigin: `http://127.0.0.1:${corePort}`,
    coreToken: CORE_TOKEN,
  },
  log: () => {},
})
const web = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: webPort })
const assertion = await new SignJWT({ email: "someone@example.com" })
  .setProtectedHeader({ alg: "RS256", kid: "capture" })
  .setIssuer(issuer)
  .setAudience(AUDIENCE)
  .setIssuedAt()
  .setExpirationTime("2h")
  .sign(privateKey)

const RECEIPT = `# Saturday errands
## Groceries
- [ ] Oat milk | $4.29
- [ ] Coffee beans, the light roast from the corner shop | $14
- [x] Lemons | $2
---
**Post office**
1. Return the library books before noon
2. Stamps | $7.30

Thanks for printing!`

const PAGES: {
  name: string
  path: string
  ready: string
  prepare?: (page: Page) => Promise<void>
}[] = [
  {
    name: "print-document",
    path: "/",
    ready: "text=Choose a PDF or image",
    prepare: async (page) => {
      await page.setInputFiles('input[type="file"]', {
        name: "Lease agreement.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("%PDF-1.7\n% capture fixture\n%%EOF\n"),
      })
      await page.getByText("Lease agreement.pdf").waitFor()
      await page.getByRole("textbox", { name: "Copies" }).fill("2")
      await page.getByRole("textbox", { name: "Pages" }).fill("1-3,5")
    },
  },
  {
    name: "print-receipt",
    path: "/?printer=receipt",
    ready: "text=Preview",
    prepare: async (page) => {
      await page.getByLabel("Text", { exact: true }).fill(RECEIPT)
      await page.getByText("Saturday errands").first().waitFor()
    },
  },
  { name: "queue", path: "/queue", ready: "text=document-118" },
  { name: "printers", path: "/printers", ready: "text=Last result" },
  { name: "stats", path: "/stats", ready: ".recharts-bar-rectangle" },
]
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 960, scale: 2 },
  { name: "390", width: 390, height: 844, scale: 2 },
] as const
if (process.env.CAPTURE_360) {
  // Supplemental narrow-phone verification without repeating the baseline suite.
  ;(
    VIEWPORTS as unknown as {
      name: string
      width: number
      height: number
      scale: number
    }[]
  ).splice(0, VIEWPORTS.length, {
    name: "360",
    width: 360,
    height: 800,
    scale: 2,
  })
}

async function shot(page: Page, name: string, fullPage = true) {
  const file = join(OUT, `${name}.png`)
  await page.screenshot({ path: file, fullPage })
  console.log(file)
}

try {
  await mkdir(OUT, { recursive: true })
  const browser = await chromium.launch()
  for (const theme of ["light", "dark"] as const)
    for (const viewport of VIEWPORTS) {
      await fetch(`http://127.0.0.1:${corePort}/internal/reset`, {
        method: "POST",
        headers: { Authorization: `Bearer ${CORE_TOKEN}` },
      })
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: viewport.scale,
        colorScheme: theme,
        reducedMotion: "reduce",
        extraHTTPHeaders: { "Cf-Access-Jwt-Assertion": assertion },
      })
      for (const target of PAGES) {
        const page = await context.newPage()
        await page.goto(origin + target.path, { waitUntil: "networkidle" })
        await page.locator(target.ready).first().waitFor()
        await target.prepare?.(page)
        await page.mouse.move(0, 0)
        await page.waitForTimeout(400)
        await shot(page, `${target.name}-${viewport.name}-${theme}`)
        await page.close()
      }
      // Exercise the real submission path once per theme: a dry run, then
      // a cancel confirmation that is dismissed rather than confirmed.
      if (viewport.name === "desktop") {
        const page = await context.newPage()
        await page.goto(origin + "/?printer=receipt", {
          waitUntil: "networkidle",
        })
        await page.getByLabel("Text", { exact: true }).fill(RECEIPT)
        await page.getByRole("switch", { name: "Dry run" }).click()
        await page.getByRole("button", { name: "Check receipt" }).click()
        await page.getByText("Nothing was printed.").waitFor()
        await page.waitForTimeout(400)
        await shot(page, `print-receipt-checked-desktop-${theme}`)
        await page.goto(origin + "/queue", { waitUntil: "networkidle" })
        await page.getByRole("button", { name: "Cancel" }).first().click()
        await page.getByRole("dialog").waitFor()
        await page.waitForTimeout(300)
        await shot(page, `queue-cancel-desktop-${theme}`, false)
        await page
          .getByRole("button", { name: "Keep job", exact: true })
          .last()
          .click()
        await page.close()
      }
      await context.close()
    }
  await browser.close()
  if (SERVE) {
    // Adds the throwaway assertion for a browser that cannot set headers.
    const proxy = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers))
        if (typeof value === "string" && key !== "host") headers.set(key, value)
      headers.set("Cf-Access-Jwt-Assertion", assertion)
      if (req.method !== "GET" && req.method !== "HEAD")
        headers.set("Origin", origin)
      const response = await fetch(origin + req.url, {
        method: req.method,
        headers,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      })
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(Buffer.from(await response.arrayBuffer()))
    })
    const port = Number(process.env.CAPTURE_PROXY_PORT || 4777)
    proxy.listen(port, "127.0.0.1")
    console.log(`Browsable on http://127.0.0.1:${port} until interrupted`)
    await new Promise(() => {})
  }
} finally {
  if (!SERVE) {
    web.close()
    core.close()
    certs.close()
  }
}
