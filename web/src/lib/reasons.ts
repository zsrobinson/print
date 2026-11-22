/**
 * CUPS and IPP printer-state-reasons in plain words, with what to do. Reasons
 * end in -report, -warning or -error; the suffix only sets the severity.
 */
export type Reason = {
  reason: string
  title: string
  action?: string
  severity: "info" | "warning" | "error"
}

const KNOWN: Record<string, { title: string; action?: string }> = {
  "media-empty": {
    title: "Out of paper",
    action: "Load paper in the tray, then check the printer's screen.",
  },
  "media-needed": {
    title: "Waiting for paper",
    action: "Load paper in the tray the job asks for.",
  },
  "media-jam": {
    title: "Paper jam",
    action: "Open the printer, remove the jammed sheet and close it again.",
  },
  "media-low": { title: "Paper is running low" },
  "toner-low": { title: "Toner is low" },
  "toner-empty": { title: "Out of toner", action: "Replace the cartridge." },
  "marker-supply-low": { title: "Ink or toner is low" },
  "marker-supply-empty": {
    title: "Out of ink or toner",
    action: "Refill or replace the supply.",
  },
  "marker-waste-almost-full": { title: "Waste ink box is nearly full" },
  "marker-waste-full": {
    title: "Waste ink box is full",
    action: "Replace the maintenance box.",
  },
  "door-open": {
    title: "A door or cover is open",
    action: "Close every cover on the printer.",
  },
  "cover-open": {
    title: "A cover is open",
    action: "Close every cover on the printer.",
  },
  "input-tray-missing": {
    title: "A paper tray is missing",
    action: "Push the tray fully back in.",
  },
  "output-area-full": {
    title: "The output tray is full",
    action: "Take the printed pages out.",
  },
  offline: {
    title: "The printer is offline",
    action: "Check it is switched on and connected to the network.",
  },
  "connecting-to-device": {
    title: "Connecting to the printer",
    action: "If this lasts, check the printer is on and reachable.",
  },
  "timed-out": {
    title: "The printer stopped answering",
    action: "Check it is switched on and connected.",
  },
  paused: {
    title: "The queue is paused in CUPS",
    action: "Resume the queue in CUPS once the printer is ready.",
  },
  shutdown: { title: "The printer is shutting down" },
  "moving-to-paused": { title: "The queue is pausing" },
  "cups-missing-filter": {
    title: "CUPS has no driver for this job",
    action: "Reinstall the printer's driver in CUPS.",
  },
  "cups-insecure-filter": {
    title: "CUPS refused an insecure driver file",
    action: "Fix the driver's file permissions in CUPS.",
  },
  "cups-waiting-for-job-completed": {
    title: "Finishing the last job",
  },
  "spool-area-full": {
    title: "The print server's spool is full",
    action: "Free disk space on the print server.",
  },
  other: {
    title: "The printer reports a problem",
    action: "Check the printer's screen.",
  },
}

export function describeReason(raw: string): Reason {
  const reason = raw.trim()
  const match = /^(.*?)(?:-(report|warning|error))?$/.exec(reason)
  const base = match?.[1] ?? reason
  const suffix = match?.[2]
  const known = KNOWN[base]
  const severity =
    suffix === "error" || base === "offline"
      ? "error"
      : suffix === "warning" || base === "paused"
        ? "warning"
        : "info"
  return {
    reason,
    severity,
    title:
      known?.title ??
      base
        .replace(/^(com|org|net)\.[\w.]+-/, "")
        .replace(/-/g, " ")
        .replace(/^\w/, (c) => c.toUpperCase()),
    action: known?.action,
  }
}

/** Meaningful reasons only: "none" and empty values are dropped. */
export function describeReasons(values: unknown) {
  const list = Array.isArray(values) ? values : []
  return list
    .map((value) =>
      typeof value === "string"
        ? value
        : value && typeof value === "object" && "reason" in value
          ? String((value as { reason: unknown }).reason)
          : ""
    )
    .map((value) => value.trim())
    .filter((value) => value && value !== "none")
    .map(describeReason)
}

const MEDIA_NAMES: Record<string, string> = {
  na_letter: "Letter",
  na_legal: "Legal",
  iso_a4: "A4",
  iso_a3: "A3",
  iso_a5: "A5",
  na_ledger: "Tabloid",
  "na_index-4x6": "4 × 6 in",
  na_5x7: "5 × 7 in",
  na_govt_letter: "8 × 10 in",
  "na_number-10": "#10 envelope",
  iso_dl: "DL envelope",
}

/** "na_letter_8.5x11in" → "Letter"; unknown names keep their dimensions. */
export function mediaLabel(name: string) {
  const parts = name.split("_")
  const key = parts.slice(0, -1).join("_")
  if (MEDIA_NAMES[key]) return MEDIA_NAMES[key]
  if (name.startsWith("roll_")) return name.replace(/^roll_/, "Roll ")
  const size = parts.at(-1)
  return size ? size.replace("x", " × ").replace(/(in|mm)$/, " $1") : name
}
