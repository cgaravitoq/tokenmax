import { env } from "cloudflare:workers";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeAll, describe, expect, it } from "vitest";
import PrivacyPage from "./privacy.astro";

let container: AstroContainer;

beforeAll(async () => {
  container = await AstroContainer.create();
});

async function render(identity: Partial<Cloudflare.Env>): Promise<string> {
  Object.assign(env, identity);
  const response = await container.renderToResponse(PrivacyPage, {
    request: new Request("http://tokenmax.test/privacy"),
  });
  return response.text();
}

describe("GET /privacy", () => {
  it("names the controller, the stored data, the cookies and the rights", async () => {
    const html = await render({
      PRIVACY_AUTHORITY_NAME: "Example DPA",
      PRIVACY_AUTHORITY_URL: "https://dpa.example",
      PRIVACY_CONTROLLER: "Jane Doe",
      PRIVACY_EMAIL: "privacy@example.com",
    });

    for (const text of [
      "<h2>Controller</h2>",
      "Jane Doe",
      'href="mailto:privacy@example.com"',
      ">privacy@example.com</a>",
      "Example DPA",
      'href="https://dpa.example"',
      ">https://dpa.example</a>",
      "never stores the plaintext key",
      "tokenmax_oauth_state",
      "tokenmax_new_key",
      "/api/u/",
    ]) {
      expect(html).toContain(text);
    }

    for (const text of ["X0000000T", "NIF", "Springfield"]) {
      expect(html).not.toContain(text);
    }
  });

  it("takes the controller identity from the environment on every render", async () => {
    const html = await render({
      PRIVACY_AUTHORITY_NAME: "Example Board",
      PRIVACY_AUTHORITY_URL: "https://board.example",
      PRIVACY_CONTROLLER: "John Roe",
      PRIVACY_EMAIL: "dpo@example.org",
    });

    for (const text of [
      "John Roe",
      'href="mailto:dpo@example.org"',
      ">dpo@example.org</a>",
      "Example Board",
      'href="https://board.example"',
      ">https://board.example</a>",
    ]) {
      expect(html).toContain(text);
    }

    expect(html).not.toContain("Jane Doe");
  });
});
