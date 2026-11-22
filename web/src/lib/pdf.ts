/**
 * Page thumbnails with pdf.js, for display only: the bytes that print are
 * always the original file. pdf.js loads on demand so the Print page stays
 * light, and runs in a same-origin worker as the page's CSP requires.
 */
import type { PDFDocumentProxy } from "pdfjs-dist"

let library: Promise<typeof import("pdfjs-dist")> | null = null

function load() {
  library ??= Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]).then(([pdfjs, worker]) => {
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default
    return pdfjs
  })
  return library
}

export type { PDFDocumentProxy }

export async function openPdf(file: Blob) {
  const pdfjs = await load()
  // pdf.js transfers its buffer to the worker; the File itself stays intact.
  const data = new Uint8Array(await file.arrayBuffer())
  return pdfjs.getDocument({
    data,
    isEvalSupported: false,
    // No network: fonts it cannot find are substituted in the thumbnail only.
    useSystemFonts: true,
    disableAutoFetch: true,
    disableStream: true,
  }).promise
}

/** Draw one page into a canvas at a CSS width, sharp on high-density screens. */
export async function renderPage(
  pdf: PDFDocumentProxy,
  number: number,
  canvas: HTMLCanvasElement,
  width: number
) {
  const page = await pdf.getPage(number)
  const base = page.getViewport({ scale: 1 })
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  const viewport = page.getViewport({ scale: (width / base.width) * ratio })
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  const context = canvas.getContext("2d")
  if (!context) return
  const task = page.render({ canvasContext: context, viewport })
  try {
    await task.promise
  } finally {
    page.cleanup()
  }
}

/** Width over height of the first page, for laying out placeholders. */
export async function pageAspect(pdf: PDFDocumentProxy, number = 1) {
  const page = await pdf.getPage(number)
  const { width, height } = page.getViewport({ scale: 1 })
  return width / height
}
