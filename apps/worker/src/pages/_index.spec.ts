import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeAll, describe, expect, it } from "vitest";
import IndexPage from "./index.astro";

let container: AstroContainer;

beforeAll(async () => {
  container = await AstroContainer.create();
});

describe("GET /", () => {
  it("links the privacy notice and documents the key revocation", async () => {
    const response = await container.renderToResponse(IndexPage, {
      request: new Request("http://tokenmax.test/"),
    });
    const html = await response.text();

    expect(html).toContain('href="/privacy"');
    expect(html).toContain("revokes every existing key");
    expect(html).toContain(
      "reinstall the collector with the new key by running:",
    );
    expect(html).toContain(
      "tokenmax install --url http://tokenmax.test --key &lt;key&gt;</code>",
    );
  });
});
