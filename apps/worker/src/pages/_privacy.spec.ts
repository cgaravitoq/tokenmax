import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeAll, describe, expect, it } from "vitest";
import PrivacyPage from "./privacy.astro";

let container: AstroContainer;

beforeAll(async () => {
  container = await AstroContainer.create();
});

describe("GET /privacy", () => {
  it("names the controller, the stored data, the cookies and the rights", async () => {
    const response = await container.renderToResponse(PrivacyPage, {
      request: new Request("http://tokenmax.test/privacy"),
    });
    const html = await response.text();

    for (const text of [
      "<h2>Controller</h2>",
      "Example Operator",
      'href="mailto:privacy@example.com"',
      "never stores the plaintext key",
      "tokenmax_oauth_state",
      "tokenmax_new_key",
      "/api/u/",
      "dpa.example",
      "privacy@example.com",
    ]) {
      expect(html).toContain(text);
    }

    for (const text of ["X0000000T", "NIF", "Springfield"]) {
      expect(html).not.toContain(text);
    }
  });
});
