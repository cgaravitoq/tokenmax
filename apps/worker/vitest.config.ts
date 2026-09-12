import { fileURLToPath } from "node:url";
import vue from "@astrojs/vue";
import { getViteConfig } from "astro/config";

export default getViteConfig(
  {
    resolve: {
      alias: [
        {
          find: /^@\//,
          replacement: `${fileURLToPath(new URL("./src", import.meta.url))}/`,
        },
        {
          find: /^cloudflare:workers$/,
          replacement: fileURLToPath(
            new URL("./src/test/cloudflare-workers.ts", import.meta.url),
          ),
        },
      ],
    },
  },
  { configFile: false, integrations: [vue()] },
);
