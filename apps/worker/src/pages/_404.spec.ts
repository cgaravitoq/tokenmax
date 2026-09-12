import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeAll, describe, expect, it } from "vitest";
import NotFoundPage from "./404.astro";

let container: AstroContainer;

beforeAll(async () => {
  container = await AstroContainer.create();
});

describe("unknown route", () => {
  it("answers with the not-found page", async () => {
    const response = await container.renderToResponse(NotFoundPage, {
      request: new Request("http://tokenmax.test/nope"),
    });
    const html = await response.text();

    expect(html).toContain("<h1>Not found</h1>");
    expect(response.status).toBe(404);
  });
});
