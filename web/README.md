# Print web

A browser front end for the print core: send documents and receipts, follow the
queue, check printer state and review usage. Built on the shared
[shell](https://github.com/zsrobinson/shell) frame (Base UI Rhea, Flexoki,
Geist) with Vite, React, TanStack Router and Query, and a Hono server on Node.

## Pages

- **Print** (home) – document or receipt.
  - Documents: several PDFs, PNGs or JPEGs of up to 10 MiB each (one job per
    file), a pasted image, or a public PDF link fetched by the core. pdf.js draws
    page thumbnails for display only; clicking them sets the page range. The
    original bytes are what print. Copies and sides follow the printer's
    reported capabilities, and a stopped or offline printer is flagged on the
    form.
  - Receipts: Markdown-ish text with a live 48-column preview that uses the
    same layout rules as the core's `format_receipt`, starters, drafts kept in
    the browser, and recent receipts to reuse.
- **Jobs** – active jobs (followed every few seconds) above a searchable,
  filterable, paginated history. Each job has a page with its timeline, options,
  plain-language failure reason, kept copy and Print again.
- **Printers** – each printer's state, reasons in plain words with what to do,
  a seven-day uptime strip, capabilities, recent jobs and a Check printer action
  that never prints. Ink, toner and paper levels are deliberately not shown.
- **Overview** – KPIs against the previous period, pages or jobs per printer
  over time, web against Claude, job sizes, busiest hours and recent activity,
  for 7, 30 or 90 days or all time. Dry runs are left out of the numbers.

Old `/queue` and `/stats` links redirect to Jobs and Overview.

Every form has a dry run that validates and lays out the job without printing.

## Server

`server.ts` builds the shell server, so every page, asset and API route requires
a valid Cloudflare Access assertion, mutating requests must come from
`PUBLIC_ORIGIN`, and request logs and `/metrics` carry only method, route
pattern, status and duration. The `/api` routes proxy to the core:

| Browser                             | Core                                  |
| ----------------------------------- | ------------------------------------- |
| `GET /api/printers`                 | `GET /internal/printers`              |
| `GET /api/printers/:id`             | `GET /internal/printers/:id`          |
| `POST /api/printers/:id/check`      | `POST /internal/printers/:id/check`   |
| `GET /api/jobs` (validated filters) | `GET /internal/jobs` (rebuilt query)  |
| `GET /api/jobs/:id`                 | `GET /internal/jobs/:id`              |
| `GET /api/jobs/:id/file`            | `GET /internal/jobs/:id/file` (bytes) |
| `POST /api/jobs` (multipart)        | `POST /internal/jobs`                 |
| `POST /api/jobs/:id/cancel`         | `POST /internal/jobs/:id/cancel`      |
| `POST /api/fetch` (`{url}`)         | `POST /internal/fetch` (PDF bytes)    |
| `GET /api/stats?range=`             | `GET /internal/stats`                 |

Printer ids are `document` or `receipt`. Job listings accept only `q` (up to
100 characters), `printer`, `status` (`active`, `finished`, `completed`,
`failed`, `canceled`), `source`, `dry_run`, `from`/`to` (`YYYY-MM-DD`), `limit`
(1–100) and `offset`; anything invalid is a 400 and the core sees a query
rebuilt from the accepted values. Kept files and fetched PDFs pass through as
bytes only when the core declares PDF, PNG, JPEG or UTF-8 text and the leading
bytes agree, up to 10 MiB plus slack, as `no-store` attachments. Links must be
`https`, without credentials, up to 2,048 characters. A job's display name
travels in its own `name` field (control characters removed, whitespace
collapsed, at most 120 characters); the file part keeps a generic name.

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
PRINT_CORE_TOKEN=dev npm run fixtures -- --empty    # no jobs
PRINT_CORE_TOKEN=dev npm run fixtures -- --failing  # every GET is a 502
npm run dev                               # Vite on 5173, /api to 8787
```

`npm run capture -- --out captures` (after `npm run build`) screenshots every
page in Chromium and Firefox at desktop, 390px and 360px in light and dark, plus
empty and error states, as `<browser>-<width>-<theme>-<page>.png`. Narrow a run
with `--browser chromium` or `--only jobs`. It runs entirely on loopback with a
throwaway Access key and the fixture core, which refuses anything but dry runs;
install browsers once with `npx playwright install chromium firefox`.
`npm run capture -- --serve` keeps a loopback proxy open that adds the test
assertion, for browsers that cannot set request headers.

`tests/receipt-cases.json` is generated from the core's `format_receipt`;
regenerate it when the receipt layout changes so the preview stays exact.

Update shell with `npm run shell:update`, review the dependency diff, run the
checks and inspect the pages before committing the new pin.
