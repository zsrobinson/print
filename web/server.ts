import { serve } from "@zsrobinson/shell/server"
import { createPrintServer } from "./server/app"
import { loadConfig } from "./server/config"

const { port, bindAddress, ...config } = loadConfig(process.env)
serve({
  fetch: createPrintServer({ config }).fetch,
  hostname: bindAddress,
  port,
})
