import { keepPreviousData, queryOptions } from "@tanstack/react-query"
import type { AppLink } from "@zsrobinson/shell"
import { ApiError, getJson, parseJson } from "@zsrobinson/shell/lib/api"
import type { PrinterId } from "./limits"
import type {
  Job,
  JobResponse,
  JobsQuery,
  JobsResponse,
  PrinterCheckResponse,
  PrinterResponse,
  PrintersResponse,
  StatsRange,
  StatsResponse,
} from "./types"

export const sessionQuery = queryOptions({
  queryKey: ["session"],
  queryFn: ({ signal }) =>
    getJson<{ email: string; services: AppLink[] }>("/api/session", signal),
  retry: false,
  staleTime: 5 * 60_000,
})

export const printersQuery = queryOptions({
  queryKey: ["printers"],
  queryFn: ({ signal }) => getJson<PrintersResponse>("/api/printers", signal),
  refetchInterval: 10_000,
})

export const printerQuery = (id: PrinterId) =>
  queryOptions({
    queryKey: ["printers", id],
    queryFn: ({ signal }) =>
      getJson<PrinterResponse>(`/api/printers/${id}`, signal),
    refetchInterval: 10_000,
  })

/** A query string from defined values only, in a stable order. */
export function toSearch(params: Record<string, unknown>) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params).sort(([a], [b]) =>
    a.localeCompare(b)
  ))
    if (value !== undefined && value !== null && value !== "")
      search.set(key, String(value))
  const text = search.toString()
  return text ? `?${text}` : ""
}

/** Live while anything is active, otherwise an occasional check. */
const follow = (data: JobsResponse | undefined) =>
  data?.jobs.some((job) => ACTIVE_STATES.has(job.state)) ? 3_000 : 15_000

export const ACTIVE_STATES = new Set([
  "pending",
  "held",
  "processing",
  "stopped",
])

export const jobsQuery = (params: JobsQuery = {}) =>
  queryOptions({
    queryKey: ["jobs", "list", params],
    queryFn: ({ signal }) =>
      getJson<JobsResponse>(`/api/jobs${toSearch(params)}`, signal),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => follow(query.state.data),
  })

/** Everything printing or waiting, followed every few seconds. */
export const activeJobsQuery = queryOptions({
  queryKey: ["jobs", "list", { status: "active", limit: 100 }],
  queryFn: ({ signal }) =>
    getJson<JobsResponse>(`/api/jobs?limit=100&status=active`, signal),
  refetchInterval: (query) => (query.state.data?.jobs.length ? 3_000 : 10_000),
})

export const jobQuery = (id: string) =>
  queryOptions({
    queryKey: ["jobs", "detail", id],
    queryFn: ({ signal }) => getJson<JobResponse>(`/api/jobs/${id}`, signal),
    refetchInterval: (query) =>
      query.state.data && ACTIVE_STATES.has(query.state.data.job.state)
        ? 3_000
        : false,
  })

export const statsQuery = (range: StatsRange) =>
  queryOptions({
    queryKey: ["stats", range],
    queryFn: ({ signal }) =>
      getJson<StatsResponse>(`/api/stats?range=${range}`, signal),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  })

/** Submit a job; XHR reports upload progress, which fetch cannot. */
export function submitJob(
  form: FormData,
  onProgress?: (fraction: number) => void
) {
  return new Promise<{ job: Job }>((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open("POST", "/api/jobs")
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total)
    }
    request.onload = () =>
      parseJson<{ job: Job }>(
        new Response(request.responseText, { status: request.status })
      ).then(resolve, reject)
    request.onerror = () =>
      reject(
        new ApiError(
          "The connection dropped. Check Jobs before trying again.",
          0
        )
      )
    request.send(form)
  })
}

export async function cancelJob(id: string) {
  return parseJson<unknown>(
    await fetch(`/api/jobs/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    })
  )
}

export async function checkPrinter(id: PrinterId) {
  return parseJson<PrinterCheckResponse>(
    await fetch(`/api/printers/${id}/check`, { method: "POST" })
  )
}

async function bytes(response: Response) {
  if (!response.ok) await parseJson<unknown>(response)
  return response.blob()
}

/** The kept copy of a job: original document bytes or receipt text. */
export async function keptFile(id: string, signal?: AbortSignal) {
  return bytes(
    await fetch(`/api/jobs/${encodeURIComponent(id)}/file`, { signal })
  )
}

/** The print service fetches a public PDF link; the bytes come back unchanged. */
export async function fetchLink(url: string, signal?: AbortSignal) {
  return bytes(
    await fetch("/api/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
      signal,
    })
  )
}
