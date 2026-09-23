import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({
  // Do not preload all routes on cold start (extra CPU → Error 1102).
  routePreloadingBehavior: "none",
});
