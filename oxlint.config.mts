import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";

export default defineConfig({
  extends: [antiSlop],
  rules: {
    "typescript/triple-slash-reference": "off", // Astro env.d.ts
    "anti-slop/no-conditional-empty-object-spread": "off", // conditional spread is the clearest optional field
    "anti-slop/no-runtime-typeof": "off", // boundary decoders use typeof
    "anti-slop/no-unknown-parameters": "off", // catch handlers take unknown
    "anti-slop/no-unsafe-dictionary-type": "off", // payloads are dictionaries until parsed
    "anti-slop/require-safety-comment-for-type-assertion": "off", // no mandatory SAFETY comments
  },
});
