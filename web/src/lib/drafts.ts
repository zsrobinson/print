/**
 * Receipt starters and drafts. Drafts stay in this browser only; the print
 * service keeps recent receipts for seven days for reuse.
 */
export type Starter = { id: string; label: string; text: string }

export const STARTERS: Starter[] = [
  {
    id: "checklist",
    label: "Checklist",
    text: "# Today\n\n- [ ] \n- [ ] \n- [ ] \n",
  },
  {
    id: "shopping",
    label: "Shopping list",
    text: "# Shopping\n\n## Produce\n- [ ] \n\n## Pantry\n- [ ] \n\n## Other\n- [ ] \n",
  },
  {
    id: "notes",
    label: "Notes",
    text: "# Notes\n\n",
  },
]

export type Draft = { id: string; text: string; saved_at: number }

const KEY = "print.receipt.drafts"
const CURRENT = "print.receipt.draft"
const MAX_DRAFTS = 12

function read<T>(storage: Storage | undefined, key: string, fallback: T): T {
  try {
    const raw = storage?.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function write(storage: Storage | undefined, key: string, value: unknown) {
  try {
    if (value === null) storage?.removeItem(key)
    else storage?.setItem(key, JSON.stringify(value))
  } catch {
    // Storage is a convenience; private windows may refuse it.
  }
}

const local = () =>
  typeof localStorage === "undefined" ? undefined : localStorage

export function listDrafts(): Draft[] {
  const drafts = read<Draft[]>(local(), KEY, [])
  return Array.isArray(drafts)
    ? drafts
        .filter((d) => d && typeof d.text === "string" && d.text.trim())
        .sort((a, b) => b.saved_at - a.saved_at)
    : []
}

export function saveDraft(text: string, id?: string): Draft {
  const draft = { id: id ?? crypto.randomUUID(), text, saved_at: Date.now() }
  const rest = listDrafts().filter((d) => d.id !== draft.id && d.text !== text)
  write(local(), KEY, [draft, ...rest].slice(0, MAX_DRAFTS))
  return draft
}

/** The editor's unsaved text, so a reload or visit elsewhere keeps it. */
export function readWorking() {
  return read<string>(local(), CURRENT, "")
}
export function writeWorking(text: string) {
  write(local(), CURRENT, text ? text : null)
}

/** The first meaningful line, as a short label. */
export function draftTitle(text: string) {
  const line = text
    .split("\n")
    .map((l) =>
      l
        .replace(/^#+\s*/, "")
        .replace(/^[-*]\s+(\[[ xX]\]\s+)?/, "")
        .replace(/\*\*|__|`/g, "")
        .trim()
    )
    .find(Boolean)
  return line ? line.slice(0, 60) : "Untitled"
}
