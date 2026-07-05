import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createTokenGraphServer } from "./server.js";

serveStdio(() => createTokenGraphServer());

