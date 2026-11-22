/**
 * A stand-in for the print core with invented data, for screenshots and local
 * development. It never talks to CUPS: every submission must be a dry run.
 *
 * About 90 days of history is generated from a fixed seed relative to
 * start-up, so the same day always yields the same pages. Modes:
 *   rich (default)  history, two active jobs, kept copies, printer history
 *   empty           no jobs and a quiet printer history
 *   failing         every GET answers 502, for error states
 */
import { createServer, type IncomingMessage, type Server } from "node:http"
import { crc32, deflateSync } from "node:zlib"
import type {
  Capabilities,
  DailyStat,
  Job,
  JobDetail,
  JobKind,
  JobOptions,
  JobSource,
  PrinterCheck,
  PrinterState,
  PrinterStateChange,
  StatsRange,
} from "../src/lib/types"

// Small, valid documents built by hand: a PDF with plain shapes and text,
// a PNG and a baseline JPEG. Nothing here reads a real file.
type Rgb = [number, number, number]

/** Deterministic 0..1 values from a string, for per-document variation. */
function noise(seed: string) {
  let h = 2166136261
  for (const char of seed) h = Math.imul(h ^ char.charCodeAt(0), 16777619)
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    h ^= h >>> 16
    return (h >>> 0) / 4294967296
  }
}

/** PDF base-14 fonts take Latin-1; keep to printable ASCII and escape. */
function pdfText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/([\\()])/g, "\\$1")
}

/**
 * A letter-size PDF: a title band, paragraphs drawn as grey rules, and a
 * small bar chart on the first page. Offsets in the xref are exact.
 */
function makePdf(title: string, pageCount: number): Buffer {
  const pages = Math.max(1, Math.min(pageCount, 6))
  const random = noise(title)
  const objects: string[] = []
  const add = (body: string) => objects.push(body) // 1-based object numbers
  add("<< /Type /Catalog /Pages 2 0 R >>")
  add("") // pages, filled below
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>")
  const kids: number[] = []
  for (let page = 1; page <= pages; page++) {
    const ops: string[] = []
    ops.push("0.93 0.94 0.96 rg 0 712 612 80 re f")
    ops.push("0.20 0.36 0.62 rg 54 742 6 28 re f")
    ops.push(
      `BT /F2 20 Tf 0.10 0.11 0.13 rg 70 748 Td (${pdfText(title).slice(0, 48)}) Tj ET`
    )
    ops.push(
      `BT /F1 9 Tf 0.45 0.46 0.50 rg 70 728 Td (Page ${page} of ${pageCount}) Tj ET`
    )
    let y = 676
    const paragraphs = 3 + Math.floor(random() * 3)
    for (let p = 0; p < paragraphs && y > 120; p++) {
      if (page === 1 && p === 1) {
        // A small chart: axis and bars.
        ops.push(
          "0.55 0.57 0.60 RG 0.8 w 72 " + (y - 150) + " m 72 " + y + " l S"
        )
        ops.push(`72 ${y - 150} m 360 ${y - 150} l S`)
        for (let bar = 0; bar < 8; bar++) {
          const height = 20 + Math.floor(random() * 120)
          ops.push(
            `0.27 0.52 0.45 rg ${84 + bar * 34} ${y - 150} 22 ${height} re f`
          )
        }
        ops.push("0.80 0.82 0.85 RG 0.6 w 390 " + (y - 150) + " 150 150 re S")
        ops.push(
          `BT /F1 8 Tf 0.35 0.36 0.40 rg 398 ${y - 14} Td (Figure ${page}) Tj ET`
        )
        y -= 180
        continue
      }
      const lines = 3 + Math.floor(random() * 5)
      for (let line = 0; line < lines && y > 100; line++) {
        const width =
          line === lines - 1 ? 120 + random() * 220 : 440 + random() * 28
        ops.push(
          `0.78 0.79 0.82 rg 72 ${y.toFixed(0)} ${width.toFixed(0)} 6 re f`
        )
        y -= 15
      }
      y -= 18
    }
    ops.push("0.85 0.86 0.88 RG 0.5 w 72 64 m 540 64 l S")
    ops.push(`BT /F1 8 Tf 0.55 0.56 0.60 rg 72 50 Td (${page}) Tj ET`)
    const stream = ops.join("\n")
    add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
    const content = objects.length
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> >>`
    )
    kids.push(objects.length)
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`
  const info = objects.length + 1
  objects.push(`<< /Title (${pdfText(title)}) /Producer (print fixture) >>`)
  let out = "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n"
  const offsets: number[] = []
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out, "latin1"))
    out += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = Buffer.byteLength(out, "latin1")
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets)
    out += `${String(offset).padStart(10, "0")} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, "latin1")
}

/** A scanned-page or screenshot-like picture, as a truecolour PNG. */
function makePng(seed: string, width = 480, height = 640): Buffer {
  const random = noise(seed)
  const rules: { y: number; width: number }[] = []
  for (let y = 120; y < height - 60; y += 22)
    if (random() > 0.12) rules.push({ y, width: 200 + random() * 200 })
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    raw[row] = 0
    for (let x = 0; x < width; x++) {
      let [r, g, b]: Rgb = [250, 249, 246]
      if (y < 70) [r, g, b] = [52, 92, 158]
      else if (x > 40 && x < width - 40) {
        const rule = rules.find((line) => y >= line.y && y < line.y + 8)
        if (rule && x < 40 + rule.width) [r, g, b] = [196, 198, 204]
      }
      // Slight paper grain.
      const grain = ((x * 7 + y * 13) % 5) - 2
      raw.set([r + grain, g + grain, b + grain], row + 1 + x * 3)
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

/** An outdoor scene: sky, sun, hills and water. */
function scene(seed: string, width: number, height: number) {
  const random = noise(seed)
  const sunX = width * (0.2 + random() * 0.6)
  const sunY = height * (0.18 + random() * 0.12)
  const hill = random() * 6
  return (x: number, y: number): Rgb => {
    const t = y / height
    const ridge =
      height * (0.55 + 0.06 * Math.sin(x / 47 + hill) + 0.03 * Math.sin(x / 13))
    if (y > height * 0.78)
      return [44 + 20 * t, 100 + 8 * Math.sin(x / 23 + y / 3), 142 + 16 * t]
    if (y > ridge) return [58 + 30 * t, 110 - 20 * t, 62]
    if (Math.hypot(x - sunX, y - sunY) < width * 0.07) return [255, 226, 150]
    return [120 + 110 * t, 170 + 60 * t, 235 - 30 * t]
  }
}

/**
 * A baseline JPEG in which every 8×8 block is one colour: only DC
 * coefficients are coded, so the encoder stays tiny and the file is valid.
 */
function makeJpeg(seed: string, width = 480, height = 640): Buffer {
  const pixel = scene(seed, width, height)
  const segment = (marker: number, body: number[]) => [
    0xff,
    marker,
    (body.length + 2) >> 8,
    (body.length + 2) & 0xff,
    ...body,
  ]
  const dcBits = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]
  const dcValues = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
  // Canonical Huffman codes for the standard luminance DC table.
  const codes: { code: number; length: number }[] = []
  let code = 0
  let k = 0
  for (let length = 1; length <= 16; length++) {
    for (let i = 0; i < dcBits[length - 1]; i++)
      codes[dcValues[k++]] = { code: code++, length }
    code <<= 1
  }
  const bytes: number[] = []
  let buffer = 0
  let filled = 0
  const write = (value: number, length: number) => {
    for (let bit = length - 1; bit >= 0; bit--) {
      buffer = (buffer << 1) | ((value >> bit) & 1)
      if (++filled === 8) {
        bytes.push(buffer)
        if (buffer === 0xff) bytes.push(0)
        buffer = 0
        filled = 0
      }
    }
  }
  const predictors = [0, 0, 0]
  for (let by = 0; by < height; by += 8)
    for (let bx = 0; bx < width; bx += 8) {
      let [r, g, b] = [0, 0, 0]
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) {
          const [pr, pg, pb] = pixel(bx + x, by + y)
          r += pr
          g += pg
          b += pb
        }
      ;[r, g, b] = [r / 64, g / 64, b / 64]
      const ycc = [
        0.299 * r + 0.587 * g + 0.114 * b,
        -0.1687 * r - 0.3313 * g + 0.5 * b + 128,
        0.5 * r - 0.4187 * g - 0.0813 * b + 128,
      ]
      ycc.forEach((value, component) => {
        const dc = Math.round(8 * (Math.max(0, Math.min(255, value)) - 128))
        const diff = dc - predictors[component]
        predictors[component] = dc
        const size = diff === 0 ? 0 : Math.floor(Math.log2(Math.abs(diff))) + 1
        write(codes[size].code, codes[size].length)
        if (size) write(diff < 0 ? diff + (1 << size) - 1 : diff, size)
        write(0, 1) // End of block: the only AC symbol, coded as "0".
      })
    }
  if (filled) write((1 << (8 - filled)) - 1, 8 - filled)
  return Buffer.from([
    0xff,
    0xd8,
    ...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...segment(0xdb, [0, ...new Array(64).fill(1)]),
    ...segment(0xc0, [
      8,
      height >> 8,
      height & 0xff,
      width >> 8,
      width & 0xff,
      3,
      1,
      0x11,
      0,
      2,
      0x11,
      0,
      3,
      0x11,
      0,
    ]),
    ...segment(0xc4, [0x00, ...dcBits, ...dcValues]),
    ...segment(0xc4, [0x10, 1, ...new Array(15).fill(0), 0x00]),
    ...segment(0xda, [3, 1, 0x00, 2, 0x00, 3, 0x00, 0, 63, 0]),
    ...bytes,
    0xff,
    0xd9,
  ])
}

export type FixtureMode = "rich" | "empty" | "failing"
type PrinterId = "document" | "receipt"

/** Stable ids for the jobs captures open directly. */
export const FIXTURE_IDS = {
  /** Document printing now. */
  printing: "5d0f3c2a9b8e4f17a6c2d9e1b0f4a7c3",
  /** Document waiting behind it. */
  waiting: "8b41e6d27c0a4f93b5e8d1c6a2f07e94",
  /** A completed PDF from yesterday with a kept copy. */
  kept: "c7e2a91f4d6b4c08a3f5e9d27b1c6a40",
  /** A job the printer stopped two days ago (kept, so it can be retried). */
  failed: "2f9d84b1e0c74a6d9b3e5f18c7a2d065",
  /** A receipt from this morning with its text kept. */
  receipt: "e41b7c09d2a84f6e8c5b3a17f9d06e28",
  /** A phone photo with a kept JPEG. */
  image: "9a06d3f7b2e14c85a7d9e0b4c1f6283d",
  /** An older job whose kept copy has expired. */
  expired: "4b7e19c3a8d24f60b1e5c9a3d7f20e81",
} as const

const DAY = 86_400_000
const MINUTE = 60_000
const KEEP_MS = 7 * DAY
const ACTIVE = new Set(["pending", "held", "processing", "stopped"])
const FAILED = new Set(["aborted", "unknown"])

/** A ledger row: the public detail plus the kept copy's content type. */
type Record_ = JobDetail & { kept_type: string | null }

/** mulberry32: small, fast and fully deterministic. */
function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pad = (n: number) => String(n).padStart(2, "0")
/** Local calendar date, as the core reports it. */
const localDate = (t: number | string) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const iso = (t: number) => new Date(t).toISOString()
/** Local midnight `days` before the day containing `t`. */
const midnight = (t: number, days = 0) => {
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - days).getTime()
}

const RECEIPTS: Record<string, string> = {
  Groceries:
    "# Groceries\n- [ ] Oat milk\n- [ ] Lemons\n- [ ] Sourdough\n- [ ] Coffee beans\n- [ ] Spinach\n- [ ] Eggs",
  "Weekend checklist":
    "# Weekend checklist\n- [ ] Water the plants\n- [ ] Return library books\n- [ ] Bike tyre pressure\n- [x] Laundry\n- [ ] Call about the dishwasher",
  Today:
    "# Today\n1. Finish lab write-up\n2. Gym at 5\n3. Pick up prescription\n\n**Remember:** trash goes out tonight",
  "Packing list":
    "# Packing list\n- [ ] Passport\n- [ ] Chargers\n- [ ] Rain jacket\n- [ ] Toiletries\n- [ ] Book for the flight",
  "Hardware store":
    "# Hardware store\n- [ ] Picture hooks\n- [ ] AA batteries\n- [ ] Wood glue\n- [ ] 3/4in screws | x20",
  "Meal plan":
    "# Meal plan\nMon | Lentil soup\nTue | Tacos\nWed | Leftovers\nThu | Stir fry\nFri | Pizza night",
  Errands:
    "# Errands\n- [ ] Post office | stamps\n- [ ] Dry cleaning\n- [ ] Bank deposit\n- [ ] Pharmacy",
  "Pancake recipe":
    "# Pancake recipe\n- 1 1/2 cups flour\n- 1 tbsp sugar\n- 2 tsp baking powder\n- 1 1/4 cups milk\n- 1 egg\n\nRest the batter 10 min.",
  "Plants to water":
    "# Plants to water\n- [ ] Fern (bathroom)\n- [ ] Pothos\n- [ ] Basil\n- [ ] Snake plant (every 2 weeks)",
  "Workout – legs":
    "# Workout - legs\nSquats | 4x8\nLunges | 3x10\nRDL | 3x8\nCalf raises | 3x15",
  "Library returns":
    "# Library returns\n- [ ] Field guide to ferns\n- [ ] Two cookbooks\n- [ ] Audiobook CDs\nDue Thursday",
  "Morning routine":
    "# Morning routine\n- [ ] Stretch\n- [ ] Coffee\n- [ ] Review calendar\n- [ ] Inbox zero (ha)",
  "Gift ideas":
    "# Gift ideas\n- [ ] Pottery class voucher\n- [ ] Good olive oil\n- [ ] Puzzle (1000 pc)\n- [ ] Plant stand",
  "Wi-Fi for guests":
    "# Wi-Fi for guests\nNetwork | Guest\nAsk at the door for the password",
}

/** A name generator: fixed names, and counters for recurring series. */
function namer(random: () => number) {
  const counters = new Map<string, number>()
  const count = (key: string, start: number, step = 1) => {
    const value = (counters.get(key) ?? start) + step
    counters.set(key, value)
    return value
  }
  const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)]
  const webPdf = [
    "Lease renewal.pdf",
    "Quarterly budget.pdf",
    "Tax return 2025 – draft.pdf",
    "Recipe – lemon olive oil cake.pdf",
    "Concert tickets.pdf",
    "Insurance card.pdf",
    "Resume – October.pdf",
    "Car registration renewal.pdf",
    "Moving checklist.pdf",
    "Return label.pdf",
    "Dentist intake form.pdf",
    "Garden plan.pdf",
    "Physics midterm review.pdf",
    "Hiking permit.pdf",
    "Train tickets – Porto.pdf",
    "Sheet music – Clair de lune.pdf",
    "Apartment floor plan.pdf",
    "Volunteer schedule.pdf",
    "Warranty card – blender.pdf",
    "Essay draft – final.pdf",
    "Museum tickets.pdf",
    "Parking permit application.pdf",
  ]
  const mcpPdf = [
    "whitepaper-v2.pdf",
    "transit-map-2026.pdf",
    "user-manual-dishwasher.pdf",
    "syllabus-fall.pdf",
    "menu.pdf",
    "field-guide-ferns.pdf",
    "Annual report summary",
    "rfc9110.pdf",
    "trail-map.pdf",
    "seed-catalog.pdf",
    "style-guide.pdf",
    "Grant proposal outline",
  ]
  const mcpText = [
    "Meeting notes",
    "Trip itinerary",
    "Reading list",
    "Study guide – cell biology",
    "Packing list",
    "Interview prep",
    "Weekly plan",
  ]
  return {
    pdf(source: JobSource) {
      const r = random()
      if (source === "web" && r < 0.14)
        return `Calc II problem set ${count("calc", 2)}.pdf`
      if (source === "web" && r < 0.24)
        return `Chem lab ${count("chem", 1)} worksheet.pdf`
      if (r < 0.32) return `Lecture ${count("lecture", 4)} slides.pdf`
      return pick(source === "web" ? webPdf : mcpPdf)
    },
    text: () => pick(mcpText),
    image() {
      const r = random()
      if (r < 0.55)
        return `IMG_${count("img", 1890, 3 + Math.floor(random() * 40))}.jpeg`
      if (r < 0.8)
        return `scan_${String(count("scan", 0)).padStart(4, "0")}.png`
      return pick(["Parking pass.png", "coupon.png", "Seating chart.png"])
    },
    receipt: () => pick(Object.keys(RECEIPTS)),
  }
}

/** Mostly short documents with a long tail. */
function pagesFor(random: () => number) {
  const r = random()
  if (r < 0.33) return 1
  if (r < 0.51) return 2
  if (r < 0.63) return 3
  if (r < 0.72) return 4
  if (r < 0.82) return 5 + Math.floor(random() * 2)
  if (r < 0.92) return 7 + Math.floor(random() * 6)
  if (r < 0.98) return 13 + Math.floor(random() * 18)
  return 31 + Math.floor(random() * 50)
}

/** Relative activity by local hour: mornings, lunch and evenings. */
const HOURS = [
  0.15, 0.06, 0.03, 0.01, 0.01, 0.04, 0.3, 0.9, 1.3, 1.0, 0.8, 0.8, 1.1, 1.0,
  0.8, 0.8, 0.9, 1.4, 1.8, 2.2, 2.3, 2.0, 1.3, 0.6,
]
/** Sunday first, as Date#getDay counts. */
const WEEKDAYS = [0.6, 1.1, 1.0, 1.05, 1.1, 0.95, 0.7]

function pickHour(random: () => number, weekend: boolean, receipt: boolean) {
  const weights = HOURS.map((w, hour) => {
    let weight = w
    if (weekend && hour >= 9 && hour <= 13) weight *= 1.7
    if (weekend && hour < 9) weight *= 0.4
    if (receipt && hour >= 7 && hour <= 10) weight *= 1.6
    return weight
  })
  let r = random() * weights.reduce((a, b) => a + b, 0)
  for (let hour = 0; hour < 24; hour++)
    if ((r -= weights[hour]) <= 0) return hour
  return 20
}

function poisson(random: () => number, lambda: number) {
  const limit = Math.exp(-lambda)
  let k = 0
  let p = 1
  do {
    k++
    p *= random()
  } while (p > limit)
  return k - 1
}

/** Outages on each printer, as offsets from local midnight `days` ago. */
function outages(now: number) {
  const spell = (
    printer: PrinterId,
    days: number,
    from: number,
    minutes: number,
    state: PrinterState,
    reasons: string[]
  ) => {
    const start = midnight(now, days) + from * MINUTE
    return { printer, start, end: start + minutes * MINUTE, state, reasons }
  }
  return [
    spell("document", 5, 70, 370, "offline", ["offline-report"]),
    spell("document", 2, 19 * 60 + 5, 43, "stopped", ["media-empty-error"]),
    spell("receipt", 4, 13 * 60, 130, "stopped", ["paused"]),
    spell("receipt", 1, 8 * 60 + 40, 25, "offline", ["offline-report"]),
  ].filter((o) => o.end < now)
}

const ERRORS = {
  unreadable: "The printer could not read the document.",
  atDevice: "Cancelled at the printer.",
  system: "CUPS stopped the job.",
  stopped: "The printer stopped the job before it finished.",
  lost: "CUPS lost track of this job, so it may or may not have printed.",
  timeout:
    "CUPS did not answer in time. The job may still print, so check the queue before retrying.",
}

function keptType(kind: JobKind, name: string) {
  if (kind === "receipt") return "text/plain; charset=utf-8"
  if (kind === "image")
    return /\.jpe?g$/i.test(name) ? "image/jpeg" : "image/png"
  return "application/pdf"
}

type Draft = {
  id?: string
  at: number
  printer: PrinterId
  source: JobSource
  kind: JobKind
  name: string
  pages: number
  documentPages: number
  copies: number
  options: JobOptions | null
  dryRun: boolean
  state: string
  error: string | null
}

/** Timeline and finish time consistent with the final state. */
function finish(draft: Draft, random: () => number) {
  const c = draft.at
  const events: { state: string; at: number }[] = [{ state: "pending", at: c }]
  if (draft.dryRun) {
    events.push({ state: "completed", at: c + 400 })
    return { events, finished: c + 400 }
  }
  const work =
    draft.kind === "receipt"
      ? 3_000
      : 8_000 + draft.pages * draft.copies * (4_000 + random() * 5_000)
  const start = c + 1_500 + random() * 4_000
  switch (draft.state) {
    case "processing":
      events.push({ state: "processing", at: start })
      return { events, finished: null }
    case "pending":
      return { events, finished: null }
    case "canceled": {
      if (random() < 0.5) events.push({ state: "processing", at: start })
      const at = c + 20_000 + random() * 100_000
      events.push({ state: "canceled", at })
      return { events, finished: at }
    }
    case "unknown": {
      events.push({ state: "processing", at: start })
      const at = c + 62 * MINUTE + random() * 10 * MINUTE
      events.push({ state: "unknown", at })
      return { events, finished: at }
    }
    default: {
      events.push({ state: "processing", at: start })
      const at =
        draft.state === "aborted" ? start + work * random() : start + work
      events.push({ state: draft.state, at })
      return { events, finished: at }
    }
  }
}

function generate(now: number): Record_[] {
  const random = prng(0x5eed2026)
  const names = namer(random)
  const spells = outages(now)
  const drafts: Draft[] = []

  const options = (kind: JobKind, pages: number): JobOptions | null => {
    if (kind === "receipt") return null
    const sides =
      kind !== "image" && pages > 1 && random() < 0.35
        ? random() < 0.9
          ? "two-sided-long-edge"
          : "two-sided-short-edge"
        : "one-sided"
    return {
      sides,
      page_range: null,
      color: kind === "image" || random() < 0.3 ? "color" : "monochrome",
      paper_size: random() < 0.06 ? "a4" : "letter",
    }
  }

  const draft = (at: number): Draft => {
    const printer: PrinterId = random() < 0.68 ? "document" : "receipt"
    const source: JobSource =
      printer === "document"
        ? random() < 0.64
          ? "web"
          : "mcp"
        : random() < 0.6
          ? "mcp"
          : "web"
    let kind: JobKind = "receipt"
    if (printer === "document") {
      const r = random()
      kind = source === "mcp" && r < 0.18 ? "text" : r < 0.84 ? "pdf" : "image"
    }
    const name =
      kind === "pdf"
        ? names.pdf(source)
        : kind === "text"
          ? names.text()
          : kind === "image"
            ? names.image()
            : names.receipt()
    let documentPages =
      kind === "pdf"
        ? pagesFor(random)
        : kind === "text"
          ? 1 + Math.floor(random() * 3)
          : 1
    let pages = documentPages
    const opts = options(kind, documentPages)
    if (opts && kind === "pdf" && documentPages >= 6 && random() < 0.25) {
      const end = 2 + Math.floor(random() * Math.min(5, documentPages - 2))
      opts.page_range = `1-${end}`
      pages = end
    }
    if (kind !== "pdf") documentPages = pages
    const r = random()
    // Several copies are for handouts and forms, not long documents.
    const copies =
      printer === "document" && pages > 6 && r >= 0.87
        ? 2
        : printer === "receipt"
          ? random() < 0.05
            ? 2
            : 1
          : r < 0.87
            ? 1
            : r < 0.95
              ? 2
              : r < 0.99 || pages > 3
                ? 3 + Math.floor(random() * 3)
                : 10
    const dryRun = random() < 0.08
    let state = "completed"
    let error: string | null = null
    if (!dryRun) {
      const s = random()
      if (s < 0.022) {
        state = "aborted"
        error = [
          ERRORS.unreadable,
          ERRORS.stopped,
          ERRORS.system,
          ERRORS.atDevice,
        ][Math.floor(random() * 4)]
      } else if (s < 0.04) {
        state = "unknown"
        error = random() < 0.75 ? ERRORS.lost : ERRORS.timeout
      } else if (s < 0.065) state = "canceled"
    }
    return {
      at,
      printer,
      source,
      kind,
      name,
      pages,
      documentPages,
      copies,
      options: opts,
      dryRun,
      state,
      error,
    }
  }

  for (let days = 89; days >= 0; days--) {
    const day = midnight(now, days)
    const weekday = new Date(day).getDay()
    let lambda = 2.05 * WEEKDAYS[weekday] * (0.8 + 0.4 * (1 - days / 89))
    if (days === 17 || days === 45) lambda *= 2.6 // A deadline week.
    if (days < 7) lambda *= 1.35 // A busy week, so recent pages are full.
    if (days === 33 || days === 34) lambda = 0.05 // Away for a few days.
    const count = poisson(random, lambda)
    for (let i = 0; i < count; i++) {
      const job = draft(0)
      const hour = pickHour(
        random,
        weekday === 0 || weekday === 6,
        job.printer === "receipt"
      )
      let at = day + hour * 3_600_000 + Math.floor(random() * 3_600_000)
      // Nothing prints while its printer is offline or stopped.
      const spell = spells.find(
        (o) => o.printer === job.printer && at >= o.start && at <= o.end
      )
      if (spell) at = spell.end + (5 + Math.floor(random() * 25)) * MINUTE
      if (at > now - 20 * MINUTE) continue
      job.at = at
      drafts.push(job)
    }
  }

  // Hand-placed jobs that captures and reviewers open directly.
  const at = (days: number, hour: number, minute: number) =>
    Math.min(
      midnight(now, days) + (hour * 60 + minute) * MINUTE,
      now - 25 * MINUTE
    )
  const document = (opts: Partial<JobOptions> = {}): JobOptions => ({
    sides: "one-sided",
    page_range: null,
    color: "monochrome",
    paper_size: "letter",
    ...opts,
  })
  const failedSpell = spells.find(
    (o) => o.state === "stopped" && o.printer === "document"
  )
  drafts.push(
    {
      id: FIXTURE_IDS.printing,
      at: now - 70_000,
      printer: "document",
      source: "web",
      kind: "pdf",
      name: "Thesis draft – chapter 3.pdf",
      pages: 24,
      documentPages: 24,
      copies: 2,
      options: document({ sides: "two-sided-long-edge" }),
      dryRun: false,
      state: "processing",
      error: null,
    },
    {
      id: FIXTURE_IDS.waiting,
      at: now - 30_000,
      printer: "document",
      source: "mcp",
      kind: "pdf",
      name: "whitepaper-v2.pdf",
      pages: 6,
      documentPages: 6,
      copies: 1,
      options: document(),
      dryRun: false,
      state: "pending",
      error: null,
    },
    {
      id: FIXTURE_IDS.kept,
      at: at(1, 18, 42),
      printer: "document",
      source: "web",
      kind: "pdf",
      name: "Lease renewal.pdf",
      pages: 4,
      documentPages: 4,
      copies: 2,
      options: document({ sides: "two-sided-long-edge" }),
      dryRun: false,
      state: "completed",
      error: null,
    },
    {
      id: FIXTURE_IDS.failed,
      at: failedSpell ? failedSpell.start - 2 * MINUTE : at(2, 19, 3),
      printer: "document",
      source: "mcp",
      kind: "pdf",
      name: "Boarding pass – Lisbon.pdf",
      pages: 3,
      documentPages: 3,
      copies: 1,
      options: document({ color: "color" }),
      dryRun: false,
      state: "aborted",
      error: ERRORS.stopped,
    },
    {
      id: FIXTURE_IDS.receipt,
      at: at(0, 8, 14),
      printer: "receipt",
      source: "mcp",
      kind: "receipt",
      name: "Weekend checklist",
      pages: 1,
      documentPages: 1,
      copies: 1,
      options: null,
      dryRun: false,
      state: "completed",
      error: null,
    },
    {
      id: FIXTURE_IDS.image,
      at: at(3, 20, 6),
      printer: "document",
      source: "web",
      kind: "image",
      name: "IMG_2041.jpeg",
      pages: 1,
      documentPages: 1,
      copies: 1,
      options: document({ color: "color" }),
      dryRun: false,
      state: "completed",
      error: null,
    },
    {
      id: FIXTURE_IDS.expired,
      at: at(12, 9, 31),
      printer: "document",
      source: "web",
      kind: "pdf",
      name: "Chem lab 4 worksheet.pdf",
      pages: 2,
      documentPages: 2,
      copies: 1,
      options: document(),
      dryRun: false,
      state: "completed",
      error: null,
    }
  )

  drafts.sort((a, b) => a.at - b.at)
  const cups = { document: 1042, receipt: 311 }
  const hex = () =>
    Array.from({ length: 32 }, () =>
      Math.floor(random() * 16).toString(16)
    ).join("")
  return drafts
    .map((d): Record_ => {
      const { events, finished } = finish(d, random)
      const cupsId = d.dryRun ? null : `${d.printer}-${cups[d.printer]++}`
      const kept = now - d.at < KEEP_MS
      const size =
        d.kind === "receipt"
          ? Buffer.byteLength(RECEIPTS[d.name] ?? d.name)
          : d.kind === "image"
            ? 900_000 + Math.floor(random() * 3_200_000)
            : 28_000 + d.documentPages * Math.floor(20_000 + random() * 90_000)
      return {
        id: d.id ?? hex(),
        cups_id: cupsId,
        printer: d.printer,
        source: d.source,
        state: d.state,
        pages: d.pages,
        copies: d.copies,
        created_at: iso(d.at),
        dry_run: d.dryRun,
        name: d.name,
        kind: d.kind,
        options: d.options,
        finished_at: finished === null ? null : iso(finished),
        size_bytes: size,
        error: d.error,
        kept_until: kept ? iso(d.at + KEEP_MS) : null,
        kept_type: kept ? keptType(d.kind, d.name) : null,
        reprintable: kept,
        events: events.map((e) => ({ state: e.state, at: iso(e.at) })),
        document_pages: d.documentPages,
      }
    })
    .reverse()
}

/** Public view of a job; reprintable is judged against the real clock. */
function view(job: Record_): Job {
  const reprintable =
    Boolean(job.kept_until) && Date.parse(job.kept_until!) > Date.now()
  return {
    id: job.id,
    cups_id: job.cups_id,
    printer: job.printer,
    source: job.source,
    state: job.state,
    pages: job.pages,
    copies: job.copies,
    created_at: job.created_at,
    dry_run: job.dry_run,
    name: job.name,
    kind: job.kind,
    options: job.options,
    finished_at: job.finished_at,
    size_bytes: job.size_bytes,
    error: job.error,
    kept_until: job.kept_until,
    reprintable,
  }
}

function detail(job: Record_): JobDetail {
  const base = view(job)
  return {
    ...base,
    events: job.events,
    document_pages: job.document_pages,
    receipt_text:
      job.kind === "receipt" && base.reprintable ? receiptText(job) : null,
  }
}

function receiptText(job: Record_) {
  return job.receipt_text ?? RECEIPTS[job.name ?? ""] ?? `# ${job.name}\n`
}

function capabilities(printer: PrinterId): Capabilities {
  return printer === "document"
    ? {
        sides: ["one-sided", "two-sided-long-edge", "two-sided-short-edge"],
        media: ["na_letter_8.5x11in", "na_legal_8.5x14in", "iso_a4_210x297mm"],
        color: true,
        make_model: "Inkjet Printer",
      }
    : {
        sides: ["one-sided"],
        media: ["roll_80mm"],
        color: false,
        make_model: "Thermal Receipt Printer",
      }
}

/** State transitions: job-driven busy spells plus outages, collapsed. */
function history(
  printer: PrinterId,
  jobs: Record_[],
  now: number,
  empty: boolean
): PrinterStateChange[] {
  const window = now - 7 * DAY
  const points: PrinterStateChange[] = [
    { state: "idle", at: iso(now - (empty ? 2 : 12) * DAY), reasons: ["none"] },
  ]
  if (empty) return points
  const raw: { at: number; state: PrinterState; reasons: string[] }[] = []
  for (const job of jobs) {
    if (job.printer !== printer || job.dry_run) continue
    const start = job.events.find((e) => e.state === "processing")
    if (!start) continue
    const at = Date.parse(start.at)
    // The sampler looks once a minute, so short jobs never show as busy.
    const end = job.finished_at ? Date.parse(job.finished_at) : now
    if (at < window || end - at < MINUTE) continue
    raw.push({ at, state: "busy", reasons: ["none"] })
    if (job.finished_at)
      raw.push({
        at: Date.parse(job.finished_at),
        state: "idle",
        reasons: ["none"],
      })
  }
  for (const spell of outages(now).filter((o) => o.printer === printer)) {
    raw.push({ at: spell.start, state: spell.state, reasons: spell.reasons })
    raw.push({ at: spell.end, state: "idle", reasons: ["none"] })
  }
  raw.sort((a, b) => a.at - b.at)
  for (const point of raw) {
    const last = points[points.length - 1]
    if (last.state === point.state) continue
    points.push({
      state: point.state,
      at: iso(point.at),
      reasons: point.reasons,
    })
  }
  return points
}

type Query = {
  q?: string
  printer?: string
  status?: string
  source?: string
  dry_run?: string
  from?: string
  to?: string
  limit: number
  offset: number
}

function parseQuery(search: URLSearchParams): Query | string {
  const get = (key: string) => search.get(key) || undefined
  const query: Query = { limit: 25, offset: 0 }
  const q = get("q")
  if (q !== undefined) {
    if (q.length > 100) return "Search text can be up to 100 characters"
    query.q = q
  }
  const choice = (key: keyof Query, values: string[]) => {
    const value = get(key)
    if (value === undefined) return null
    if (!values.includes(value)) return `Invalid ${key}`
    ;(query as Record<string, unknown>)[key] = value
    return null
  }
  const problem =
    choice("printer", ["document", "receipt"]) ??
    choice("status", [
      "active",
      "finished",
      "completed",
      "failed",
      "canceled",
    ]) ??
    choice("source", ["web", "mcp"]) ??
    choice("dry_run", ["true", "false"])
  if (problem) return problem
  for (const key of ["from", "to"] as const) {
    const value = get(key)
    if (value === undefined) continue
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return `Invalid ${key}`
    query[key] = value
  }
  for (const [key, max] of [
    ["limit", 100],
    ["offset", 100_000],
  ] as const) {
    const value = get(key)
    if (value === undefined) continue
    const n = Number(value)
    if (!Number.isInteger(n) || n < (key === "limit" ? 1 : 0) || n > max)
      return `Invalid ${key}`
    query[key] = n
  }
  return query
}

function matches(job: Record_, query: Query) {
  if (
    query.q &&
    !(job.name ?? "").toLowerCase().includes(query.q.toLowerCase())
  )
    return false
  if (query.printer && job.printer !== query.printer) return false
  if (query.source && job.source !== query.source) return false
  if (query.dry_run && String(job.dry_run) !== query.dry_run) return false
  const status = query.status
  if (status === "active" && !ACTIVE.has(job.state)) return false
  if (status === "finished" && ACTIVE.has(job.state)) return false
  if (status === "completed" && job.state !== "completed") return false
  if (status === "failed" && !FAILED.has(job.state)) return false
  if (status === "canceled" && job.state !== "canceled") return false
  const day = localDate(job.created_at)
  if (query.from && day < query.from) return false
  if (query.to && day > query.to) return false
  return true
}

const SIZE_BUCKETS = ["1", "2–5", "6–10", "11–25", "26+"] as const
const RANGE_DAYS: Record<StatsRange, number | null> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  all: null,
}

/** The same aggregation as the core's job_history.stats. */
function stats(jobs: Record_[], range: StatsRange, now: number) {
  const days = RANGE_DAYS[range]
  const today = localDate(now)
  const first = jobs.length
    ? jobs.reduce(
        (min, j) => (j.created_at < min ? j.created_at : min),
        jobs[0].created_at
      )
    : null
  const start =
    days === null
      ? first && localDate(first) < today
        ? localDate(first)
        : today
      : localDate(midnight(now, days - 1))
  const within = (job: Record_, from: string, to: string) => {
    const day = localDate(job.created_at)
    return day >= from && day <= to
  }
  const real = jobs.filter((j) => !j.dry_run && within(j, start, today))
  const daily = new Map<string, DailyStat>()
  for (const job of real) {
    const date = localDate(job.created_at)
    const key = `${date}|${job.printer}|${job.source}`
    const row = daily.get(key) ?? {
      date,
      printer: job.printer,
      source: job.source,
      jobs: 0,
      pages: 0,
      failures: 0,
    }
    row.jobs++
    row.pages += (job.pages ?? 0) * job.copies
    if (FAILED.has(job.state)) row.failures++
    daily.set(key, row)
  }
  const rows = [...daily.values()].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.printer.localeCompare(b.printer) ||
      a.source.localeCompare(b.source)
  )
  const total = (list: Record_[]) => ({
    jobs: list.length,
    pages: list.reduce((sum, j) => sum + (j.pages ?? 0) * j.copies, 0),
    failures: list.filter((j) => FAILED.has(j.state)).length,
  })
  let previous = null
  if (days !== null) {
    const startTime = midnight(now, days - 1)
    previous = total(
      jobs.filter(
        (j) =>
          !j.dry_run &&
          within(
            j,
            localDate(midnight(startTime, days)),
            localDate(midnight(startTime, 1))
          )
      )
    )
  }
  const hours = new Map<
    string,
    { weekday: number; hour: number; jobs: number }
  >()
  for (const job of real) {
    const d = new Date(job.created_at)
    const weekday = (d.getDay() + 6) % 7
    const key = `${weekday}|${d.getHours()}`
    const row = hours.get(key) ?? { weekday, hour: d.getHours(), jobs: 0 }
    row.jobs++
    hours.set(key, row)
  }
  const sizes = SIZE_BUCKETS.map((bucket) => ({ bucket, jobs: 0 }))
  for (const job of real) {
    const n = (job.pages ?? 0) * job.copies
    sizes[n <= 1 ? 0 : n <= 5 ? 1 : n <= 10 ? 2 : n <= 25 ? 3 : 4].jobs++
  }
  return {
    range,
    start,
    end: today,
    daily: rows,
    totals: {
      ...total(real),
      dry_runs: jobs.filter((j) => j.dry_run && within(j, start, today)).length,
    },
    previous,
    hours: [...hours.values()].sort(
      (a, b) => a.weekday - b.weekday || a.hour - b.hour
    ),
    sizes,
    first_job: first,
  }
}

/** Display name the core would derive for a submission. */
function submittedName(form: FormData, printer: PrinterId) {
  const clean = (value: string) =>
    value
      .replace(/\p{C}+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || null
  const name = form.get("name")
  if (typeof name === "string" && clean(name)) return clean(name)
  const text = form.get("text")
  if (printer === "receipt" && typeof text === "string") {
    const line = text.split("\n").find((l) => l.trim())
    if (line)
      return clean(line.replace(/^#+\s*|^[-*]\s*(\[[ xX]\]\s*)?|\*\*/g, ""))
  }
  return printer === "receipt" ? "Receipt" : "Document"
}

export function createFixtureCore(
  token: string,
  { mode = "rich", now: fixedNow }: { mode?: FixtureMode; now?: number } = {}
): Server {
  // Relative to start-up, so ages read naturally in screenshots.
  const now = fixedNow ?? Date.now()
  const initial = () => (mode === "rich" ? generate(now) : [])
  const jobs: Record_[] = initial()
  const files = new Map<string, Buffer>()

  const fileFor = (job: Record_) => {
    const cached = files.get(job.id)
    if (cached) return cached
    const title = job.name ?? "Document"
    const bytes =
      job.kept_type === "image/jpeg"
        ? makeJpeg(title)
        : job.kept_type === "image/png"
          ? makePng(title)
          : job.kept_type?.startsWith("text/plain")
            ? Buffer.from(receiptText(job))
            : makePdf(title, job.document_pages ?? job.pages ?? 1)
    files.set(job.id, bytes)
    return bytes
  }

  const printer = (id: PrinterId) => {
    const own = jobs.filter((j) => j.printer === id)
    const busy = own.some((j) => j.state === "processing")
    const last = own.find((j) => !j.dry_run && !ACTIVE.has(j.state))
    return {
      id,
      state: (busy ? "busy" : "idle") as PrinterState,
      accepting: true,
      status:
        id === "document"
          ? {
              ...(busy
                ? { printer_state_message: "Printing page 7 of 24" }
                : {}),
              reasons: ["none"],
              queried_at: iso(Date.now() - 12_000),
            }
          : { reasons: [], queried_at: iso(Date.now() - 12_000) },
      capabilities: capabilities(id),
      last_job: last ? view(last) : null,
    }
  }

  const queue = (id: PrinterId) => {
    const own = jobs.filter((j) => j.printer === id && j.cups_id)
    const shown = [
      ...own.filter((j) => !ACTIVE.has(j.state)).slice(0, 4),
      ...own.filter((j) => ACTIVE.has(j.state)),
    ]
    return shown
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((j) => `${j.cups_id} ${j.state}`)
      .join("\n")
  }

  const check = (id: PrinterId) => {
    const state = printer(id).state
    const checks: PrinterCheck[] = [
      { id: "cups", label: "CUPS", ok: true, detail: "CUPS answered" },
      { id: "queue", label: "Queue", ok: true, detail: "The queue exists" },
      {
        id: "accepting",
        label: "Accepting jobs",
        ok: true,
        detail: "Accepting jobs",
      },
      {
        id: "state",
        label: "State",
        ok: true,
        detail: state === "busy" ? "Printing" : "Idle and ready",
      },
      id === "receipt"
        ? {
            id: "device",
            label: "Device",
            ok: null,
            detail: "Raw queue; no device query",
          }
        : {
            id: "device",
            label: "Device",
            ok: true,
            detail: "The printer answered over IPP",
          },
    ]
    return {
      printer: id,
      checked_at: iso(Date.now()),
      ok: !checks.some((c) => c.ok === false),
      checks,
    }
  }

  const readForm = (req: IncomingMessage) =>
    new Request("http://fixture", {
      method: "POST",
      headers: { "Content-Type": req.headers["content-type"] ?? "" },
      body: req as unknown as ReadableStream,
      duplex: "half",
    } as RequestInit).formData()

  return createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" })
      res.end(JSON.stringify(body))
    }
    const raw = (type: string, bytes: Buffer) => {
      res.writeHead(200, {
        "Content-Type": type,
        "Content-Length": bytes.length,
        "Cache-Control": "no-store",
      })
      res.end(bytes)
    }
    if (req.headers.authorization !== `Bearer ${token}`)
      return send(401, { error: "Unauthorized" })
    const url = new URL(req.url ?? "/", "http://fixture")
    const path = url.pathname
    if (req.method === "POST" && path === "/internal/reset") {
      jobs.splice(0, jobs.length, ...initial())
      files.clear()
      return send(200, { ok: true })
    }
    if (req.method === "GET" && path === "/internal/fixture")
      return send(200, { mode, ids: FIXTURE_IDS })
    if (mode === "failing" && req.method === "GET")
      return send(502, { error: "Fixture core is failing on purpose" })

    if (req.method === "GET" && path === "/internal/printers")
      return send(200, { printers: [printer("document"), printer("receipt")] })
    const printerPath =
      /^\/internal\/printers\/(document|receipt)(\/check)?$/.exec(path)
    if (printerPath) {
      const id = printerPath[1] as PrinterId
      if (printerPath[2] && req.method === "POST") return send(200, check(id))
      if (!printerPath[2] && req.method === "GET")
        return send(200, {
          printer: {
            ...printer(id),
            history: history(id, jobs, now, mode === "empty"),
            recent_jobs: jobs
              .filter((j) => j.printer === id)
              .slice(0, 10)
              .map(view),
            queue: queue(id),
          },
        })
    }
    if (/^\/internal\/printers\//.test(path))
      return send(404, { error: "Unknown printer" })

    if (req.method === "GET" && path === "/internal/jobs") {
      const query = parseQuery(url.searchParams)
      if (typeof query === "string") return send(400, { error: query })
      const found = jobs.filter((j) => matches(j, query))
      return send(200, {
        jobs: found.slice(query.offset, query.offset + query.limit).map(view),
        total: found.length,
      })
    }
    const jobPath = /^\/internal\/jobs\/([^/]+)(\/file|\/cancel)?$/.exec(path)
    if (jobPath) {
      const job = jobs.find((j) => j.id === decodeURIComponent(jobPath[1]))
      if (!job) return send(404, { error: "Unknown job" })
      if (req.method === "GET" && !jobPath[2])
        return send(200, { job: detail(job) })
      if (req.method === "GET" && jobPath[2] === "/file") {
        if (!view(job).reprintable || !job.kept_type)
          return send(404, { error: "The kept copy has expired" })
        return raw(job.kept_type, fileFor(job))
      }
      if (req.method === "POST" && jobPath[2] === "/cancel") {
        if (!ACTIVE.has(job.state))
          return send(409, { error: "The job has already finished" })
        const at = iso(Date.now())
        job.state = "canceled"
        job.finished_at = at
        job.events.push({ state: "canceled", at })
        return send(200, { cancelled: job.id })
      }
    }
    if (req.method === "POST" && path === "/internal/fetch") {
      const link = (await readForm(req)).get("url")
      if (typeof link !== "string" || !link.startsWith("https://"))
        return send(400, { error: "Only https links can be fetched" })
      if (link.includes("fail"))
        return send(400, { error: "That link did not return a PDF" })
      const base = decodeURIComponent(
        new URL(link).pathname.split("/").pop() || ""
      )
      return raw("application/pdf", makePdf(base || "Linked document", 3))
    }
    if (req.method === "GET" && path === "/internal/stats") {
      const range = (url.searchParams.get("range") || "30d") as StatsRange
      if (!(range in RANGE_DAYS)) return send(400, { error: "Unknown range" })
      return send(200, stats(jobs, range, Date.now()))
    }
    if (req.method === "POST" && path === "/internal/jobs") {
      const form = await readForm(req)
      if (form.get("dry_run") !== "true")
        return send(400, { error: "Fixture core only accepts dry runs" })
      const id = form.get("printer") === "receipt" ? "receipt" : "document"
      const file = form.get("file")
      const type = file instanceof Blob ? file.type : null
      const kind: JobKind =
        id === "receipt"
          ? "receipt"
          : type?.startsWith("image/")
            ? "image"
            : "pdf"
      const text = form.get("text")
      const created = Date.now()
      const pages = kind === "pdf" ? 2 : 1
      const job: Record_ = {
        id: Array.from({ length: 32 }, () =>
          Math.floor(Math.random() * 16).toString(16)
        ).join(""),
        cups_id: null,
        printer: id,
        source: "web",
        state: "completed",
        pages,
        copies: Number(form.get("copies") || 1),
        created_at: iso(created),
        dry_run: true,
        name: submittedName(form, id),
        kind,
        options:
          id === "receipt"
            ? null
            : {
                sides: String(
                  form.get("duplex") || "one-sided"
                ) as JobOptions["sides"],
                page_range: (form.get("page_range") as string | null) ?? null,
                color: "monochrome",
                paper_size: "letter",
              },
        finished_at: iso(created + 400),
        size_bytes:
          file instanceof Blob
            ? file.size
            : Buffer.byteLength(String(text ?? "")),
        error: null,
        kept_until: iso(created + KEEP_MS),
        kept_type: kind === "receipt" ? "text/plain; charset=utf-8" : type,
        reprintable: true,
        events: [
          { state: "pending", at: iso(created) },
          { state: "completed", at: iso(created + 400) },
        ],
        document_pages: pages,
        receipt_text: typeof text === "string" ? text : null,
      }
      if (file instanceof Blob)
        files.set(job.id, Buffer.from(await file.arrayBuffer()))
      jobs.unshift(job)
      return send(201, { job: view(job) })
    }
    send(404, { error: "Not found" })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const token = process.env.PRINT_CORE_TOKEN
  if (!token) throw Error("Set PRINT_CORE_TOKEN for the fixture core")
  const flag = process.argv.find((a) => ["--empty", "--failing"].includes(a))
  const mode = (flag?.slice(2) ??
    process.env.FIXTURE_MODE ??
    "rich") as FixtureMode
  if (!["rich", "empty", "failing"].includes(mode))
    throw Error("FIXTURE_MODE must be rich, empty or failing")
  const port = Number(process.env.FIXTURE_PORT || 8772)
  createFixtureCore(token, { mode }).listen(port, "127.0.0.1", () =>
    console.log(`Fixture core (${mode}) on http://127.0.0.1:${port}`)
  )
}
