import { queryOptions } from "@tanstack/react-query"
import type { AppLink } from "@zsrobinson/shell"
import { ApiError, getJson, parseJson } from "@zsrobinson/shell/lib/api"
import { isActive } from "./jobs"
import type {
  Job,
  JobsResponse,
  PrintersResponse,
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

export const jobsQuery = queryOptions({
  queryKey: ["jobs"],
  queryFn: ({ signal }) => getJson<JobsResponse>("/api/jobs", signal),
  // Follow active jobs closely; otherwise check back occasionally.
  refetchInterval: (query) =>
    query.state.data?.jobs.some(isActive) ? 3_000 : 15_000,
})

export const statsQuery = queryOptions({
  queryKey: ["stats"],
  queryFn: ({ signal }) => getJson<StatsResponse>("/api/stats", signal),
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
          "The connection dropped. Check the queue before trying again.",
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
