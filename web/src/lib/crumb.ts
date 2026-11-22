import { useEffect, useSyncExternalStore } from "react"

// The detail page names the last breadcrumb and the document title.
let current: string | undefined
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function useCrumbLabel() {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => current
  )
}

export function usePageTitle(title: string | undefined, detail = false) {
  useEffect(() => {
    document.title = title ? `${title} · Print` : "Print"
    if (!detail) return
    current = title
    emit()
    return () => {
      current = undefined
      emit()
    }
  }, [title, detail])
}
