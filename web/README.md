# Print web

A browser front end for the print core: send documents and receipts, follow the
queue, check printer state and review usage. Built on the shared
[shell](https://github.com/zsrobinson/shell) frame (Base UI Rhea, Flexoki,
Geist) with Vite, React, TanStack Router and Query, and a Hono server on Node.

## Pages

- **Print** – document or receipt. Documents are a PDF, PNG or JPEG of up to
  10 MiB, forwarded with their original bytes, plus copies, sides and a PDF page
  range. Receipts are Markdown-ish text with a live 48-column preview that uses
  the same layout rules as the core's `format_receipt`.
- **Queue** – active jobs with cancel, recent jobs, and the raw CUPS view.
- **Printers** – state, the printer's message and reasons, and the last result.
  Ink, toner and paper reports are deliberately not shown.
- **Stats** – daily jobs, pages and failures split by printer or source, with
  totals and a breakdown table.

Every form has a dry run that validates and lays out the job without printing.

## Server

`server.ts` builds the shell server, so every page, asset and API route requires
a valid Cloudflare Access assertion, mutating requests must come from
`PUBLIC_ORIGIN`, and request logs and `/metrics` carry only method, route
pattern, status and duration. The `/api` routes proxy to the core:

| Browser                      | Core                             |
| ---------------------------- | -------------------------------- |
| `GET /api/printers`          | `GET /internal/printers`         |
| `GET /api/jobs`              | `GET /internal/jobs`             |
| `GET /api/stats`             | `GET /internal/stats`            |
| `POST /api/jobs` (multipart) | `POST /internal/jobs`            |
| `POST /api/jobs/:id/cancel`  | `POST /internal/jobs/:id/cancel` |

The core token is added server-side and only ever sent to a loopback
`PRINT_CORE_URL`. Browser headers, cookies and query strings are not forwarded,
and replies are re-serialised so core headers never reach the browser. Uploads
stop at the body limit; jobs are rebuilt from allow-listed fields, the file type
comes from its leading bytes, and the core's 5xx and auth failures surface as a
generic 502.

Configuration is in [`.env.example`](.env.example). Keep the service manifest
and credentials outside this repository.

## Development

```sh
npm ci
npm run check            # types, lint, formatting, tests
npm run build
```

For local work, run a fixture core and the app against it:

```sh
PRINT_CORE_TOKEN=dev npm run fixtures     # invented data, dry runs only
npm run dev                               # Vite on 5173, /api to 8787
```

`npm run capture` (after `npm run build`) screenshots every page at desktop and
390px in light and dark into `captures/`. It runs entirely on loopback with a
throwaway Access key and the fixture core, which refuses anything but dry runs.
`npm run capture -- --serve` keeps a loopback proxy open that adds the test
assertion, for browsers that cannot set request headers.

`tests/receipt-cases.json` is generated from the core's `format_receipt`;
regenerate it when the receipt layout changes so the preview stays exact.

Update shell with `npm run shell:update`, review the dependency diff, run the
checks and inspect the pages before committing the new pin.
