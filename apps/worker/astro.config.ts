import cloudflare from "@astrojs/cloudflare";
import vue from "@astrojs/vue";
import { defineConfig } from "astro/config";

export default defineConfig({
  adapter: cloudflare({ imageService: "compile" }),
  session: { driver: { entrypoint: "unstorage/drivers/null" } },
  integrations: [vue()],
  compressHTML: true,
  build: { format: "file" },
  security: { checkOrigin: false },
});
