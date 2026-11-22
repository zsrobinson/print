/**
 * Screenshot every page against the fixture core in Chromium and Firefox, at
 * desktop and phone widths in light and dark, plus empty and error states.
 * Everything binds to loopback; Access is satisfied by a throwaway key
 * generated for this run, and the fixture core accepts only dry runs, so
 * nothing can reach a printer.
 *
 *   npm run build && npm run capture -- --out captures
 *   npm run capture -- --browser chromium --only jobs   # a quicker subset
 *   npm run capture -- --serve      # also keep a header-adding loopback
 *                                   # proxy for a browser (rich fixture)
 *
 * Files are named <browser>-<width>-<theme>-<page>.png, with empty- and
 * error- prefixes on the page for the state sets.
 */
import { mkdir } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { serve } from "@hono/node-server"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import {
  chromium,
  firefox,
  type Browser,
  type BrowserType,
  type Page,
} from "@playwright/test"
import { createPrintServer } from "../server/app"
import {
  createFixtureCore,
  FIXTURE_IDS,
  type FixtureMode,
} from "./fixture-core"

const { values: args } = parseArgs({
  options: {
    out: { type: "string" },
    serve: { type: "boolean", default: false },
    browser: { type: "string", multiple: true },
    only: { type: "string", multiple: true },
  },
})
const OUT = args.out || process.env.CAPTURE_DIR || "captures"
const AUDIENCE = "capture-audience"
const CORE_TOKEN = "capture-only-core-token"

const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as { port: number }).port)
    )
  )
const freePort = () =>
  new Promise<number>((resolve) => {
    const placeholder = createServer()
    placeholder.listen(0, "127.0.0.1", () => {
      const { port } = placeholder.address() as { port: number }
      placeholder.close(() => resolve(port))
    })
  })

const { publicKey, privateKey } = await generateKeyPair("RS256")
const jwk = { ...(await exportJWK(publicKey)), kid: "capture", alg: "RS256" }
const certs = createServer((_req, res) => {
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify({ keys: [jwk] }))
})
const issuer = `http://127.0.0.1:${await listen(certs)}`
const assertion = await new SignJWT({ email: "someone@example.com" })
  .setProtectedHeader({ alg: "RS256", kid: "capture" })
  .setIssuer(issuer)
  .setAudience(AUDIENCE)
  .setIssuedAt()
  .setExpirationTime("2h")
  .sign(privateKey)

/** A fixture core and the real web server in front of it. */
async function stack(mode: FixtureMode) {
  const core = createFixtureCore(CORE_TOKEN, { mode })
  const corePort = await listen(core)
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
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
  const web = serve({ fetch: app.fetch, hostname: "127.0.0.1", port })
  return {
    origin,
    reset: () =>
      fetch(`http://127.0.0.1:${corePort}/internal/reset`, {
        method: "POST",
        headers: { Authorization: `Bearer ${CORE_TOKEN}` },
      }),
    close: () => {
      web.close()
      core.close()
    },
  }
}

/** `ready` is a selector to wait for beyond the usual settling. */
type Target = { name: string; path: string; ready?: string }
const PAGES: Target[] = [
  { name: "print-document", path: "/" },
  { name: "print-receipt", path: "/?printer=receipt" },
  { name: "jobs", path: "/jobs" },
  { name: "job-kept", path: `/jobs/${FIXTURE_IDS.kept}` },
  { name: "job-failed", path: `/jobs/${FIXTURE_IDS.failed}` },
  { name: "printers", path: "/printers" },
  { name: "printer-document", path: "/printers/document" },
  { name: "printer-receipt", path: "/printers/receipt" },
  { name: "overview", path: "/overview" },
]
const STATES: { mode: FixtureMode; prefix: string; pages: Target[] }[] = [
  {
    mode: "empty",
    prefix: "empty-",
    pages: [
      { name: "jobs", path: "/jobs" },
      { name: "overview", path: "/overview" },
    ],
  },
  {
    mode: "failing",
    prefix: "error-",
    // Queries retry with backoff before the error shows.
    pages: [{ name: "jobs", path: "/jobs", ready: '[role="alert"]' }],
  },
]
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 960 },
  { name: "390", width: 390, height: 844 },
  { name: "360", width: 360, height: 800 },
] as const
const BROWSERS: Record<string, BrowserType> = { chromium, firefox }
const browsers = (
  args.browser?.length ? args.browser : Object.keys(BROWSERS)
).map((name) => {
  if (!BROWSERS[name]) throw Error(`Unknown browser ${name}`)
  return name
})
const wanted = (target: Target) =>
  !args.only?.length || args.only.includes(target.name)

/** Animations off before any script runs, so every frame is the last one. */
const STILL = `
  *, *::before, *::after {
    animation-duration: 0s !important; animation-delay: 0s !important;
    transition-duration: 0s !important; transition-delay: 0s !important;
    caret-color: transparent !important; scroll-behavior: auto !important;
  }`

async function settle(page: Page) {
  await page.waitForLoadState("networkidle")
  // Loading placeholders, then charts, then one more quiet moment.
  await page
    .locator('[aria-busy="true"]')
    .first()
    .waitFor({ state: "detached", timeout: 5_000 })
    .catch(() => {})
  const charts = page.locator(".recharts-wrapper")
  if (await charts.count()) {
    await page
      .locator(".recharts-surface")
      .first()
      .waitFor({ timeout: 5_000 })
      .catch(() => {})
    // Recharts animates in JavaScript; give it time to finish drawing.
    await page.waitForTimeout(1_200)
  }
  await page.evaluate(() => document.fonts.ready)
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
}

async function capture(
  browser: Browser,
  browserName: string,
  origin: string,
  reset: () => Promise<unknown>,
  targets: Target[],
  prefix: string,
  viewports: readonly (typeof VIEWPORTS)[number][],
  themes: readonly ("light" | "dark")[]
) {
  for (const theme of themes)
    for (const viewport of viewports) {
      await reset()
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 2,
        colorScheme: theme,
        reducedMotion: "reduce",
        extraHTTPHeaders: { "Cf-Access-Jwt-Assertion": assertion },
      })
      await context.addInitScript((css) => {
        const add = () => {
          const style = document.createElement("style")
          style.textContent = css
          document.head.append(style)
        }
        if (document.head) add()
        else document.addEventListener("DOMContentLoaded", add)
      }, STILL)
      for (const target of targets.filter(wanted)) {
        const page = await context.newPage()
        const response = await page.goto(origin + target.path, {
          waitUntil: "networkidle",
        })
        if (!response?.ok())
          throw Error(`${target.path} answered ${response?.status()}`)
        if (target.ready)
          await page
            .locator(target.ready)
            .first()
            .waitFor({ timeout: 20_000 })
            .catch(() =>
              console.warn(`${target.path}: ${target.ready} not seen`)
            )
        await settle(page)
        const file = join(
          OUT,
          `${browserName}-${viewport.name}-${theme}-${prefix}${target.name}.png`
        )
        await page.screenshot({
          path: file,
          fullPage: true,
          animations: "disabled",
        })
        console.log(file)
        await page.close()
      }
      await context.close()
    }
}

const rich = await stack("rich")
const states = await Promise.all(
  STATES.map(async (state) => ({ ...state, ...(await stack(state.mode)) }))
)
try {
  await mkdir(OUT, { recursive: true })
  for (const name of browsers) {
    const browser = await BROWSERS[name].launch()
    try {
      await capture(
        browser,
        name,
        rich.origin,
        rich.reset,
        PAGES,
        "",
        VIEWPORTS,
        ["light", "dark"]
      )
      for (const state of states)
        await capture(
          browser,
          name,
          state.origin,
          state.reset,
          state.pages,
          state.prefix,
          VIEWPORTS.slice(0, 2),
          ["light"]
        )
    } finally {
      await browser.close()
    }
  }
  if (args.serve) {
    // Adds the throwaway assertion for a browser that cannot set headers.
    const proxy = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const headers = new Headers()
      for (const [key, value] of Object.entries(req.headers))
        if (typeof value === "string" && key !== "host") headers.set(key, value)
      headers.set("Cf-Access-Jwt-Assertion", assertion)
      if (req.method !== "GET" && req.method !== "HEAD")
        headers.set("Origin", rich.origin)
      const response = await fetch(rich.origin + req.url, {
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
  if (!args.serve) {
    rich.close()
    for (const state of states) state.close()
    certs.close()
  }
}
