import vueRenderer from "@astrojs/vue/server.js";
import { App } from "astro/app";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeAll, describe, expect, it } from "vitest";
import KeysPage from "./keys.astro";

const key = `tmx_${"ab".repeat(32)}`;

let container: AstroContainer;

beforeAll(async () => {
  container = await AstroContainer.create();
  container.addServerRenderer({ name: "@astrojs/vue", renderer: vueRenderer });
  container.addClientRenderer({
    name: "@astrojs/vue",
    entrypoint: "@astrojs/vue/client.js",
  });
});

async function render(
  headers?: HeadersInit,
): Promise<{ html: string; cookies: string[] }> {
  const response = await container.renderToResponse(KeysPage, {
    request: new Request("http://tokenmax.test/keys", { headers }),
  });
  return {
    html: await response.text(),
    cookies: [...App.getSetCookieFromResponse(response)],
  };
}

describe("GET /keys", () => {
  it("shows the key once and deletes the cookie on /keys", async () => {
    const { html, cookies } = await render({
      Cookie: `tokenmax_new_key=${key}`,
    });

    expect(html.split(`<code>${key}</code>`)).toHaveLength(2);
    expect(html).toContain(
      `props="{&quot;apiKey&quot;:[0,&quot;${key}&quot;]}" ssr client="load"`,
    );
    expect(html.split(key)).toHaveLength(3);
    expect(html).not.toContain("No key to show");
    expect(html).toContain('href="/privacy"');
    expect(html).toContain("revokes every existing key");
    expect(html).toContain(
      "reinstall the collector from the portfolio repository root with the new key by running:",
    );
    expect(html).toContain(
      "bun run tokenmax:install -- --url http://tokenmax.test --key &lt;key&gt;</code>",
    );
    expect(cookies).toHaveLength(1);
    const attributes = cookies[0]?.split("; ") ?? [];
    expect(attributes[0]).toBe("tokenmax_new_key=deleted");
    expect(attributes).toContain("Path=/keys");
    expect(attributes).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  });

  it("points a visitor without a key back to GitHub", async () => {
    const { html, cookies } = await render();

    expect(html).toContain(
      "No key to show. Signing in again issues a new key and revokes every existing key of your login on every machine; reinstall the collector from the portfolio repository root with the new key by running:",
    );
    expect(html).toContain('<a href="/auth/github">Sign in with GitHub</a>');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain("revokes every existing key");
    expect(html).toContain(
      "reinstall the collector from the portfolio repository root with the new key by running:",
    );
    expect(html).toContain(
      "bun run tokenmax:install -- --url http://tokenmax.test --key &lt;key&gt;</code>",
    );
    expect(html).not.toContain("tmx_");
    expect(html).not.toContain("astro-island");
    expect(cookies).toEqual([]);
  });
});
