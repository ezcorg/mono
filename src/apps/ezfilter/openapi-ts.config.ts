import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  client: "@hey-api/client-fetch",
  input: "../witmproxy/api/generated/openapi.json",
  output: {
    path: "src/lib/api/generated",
    lint: false,
    format: false,
  },
});
