import { describe, expect, it } from "bun:test";

const workflowPath = new URL(
  "../.github/workflows/release.yml",
  import.meta.url,
);
const workflowSource = await Bun.file(workflowPath).text();

const checkoutAction =
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const setupNodeAction =
  "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const setupBunAction =
  "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6";

const publishRun = `version="\${GITHUB_REF_NAME#collector-v}"
if npm view "tokenmax-collector@$version" version; then
  echo "tokenmax-collector@$version is already published"
  exit 0
fi
npm publish --provenance --access public
`;

const releaseRun =
  'gh release view "$GITHUB_REF_NAME" || gh release create "$GITHUB_REF_NAME" --verify-tag --generate-notes --title "tokenmax-collector ${GITHUB_REF_NAME#collector-v}"';

const expectedWorkflow = {
  name: "Release collector",
  on: { push: { tags: ["collector-v*"] } },
  permissions: { contents: "write", "id-token": "write" },
  concurrency: {
    group: "release-${{ github.ref }}",
    "cancel-in-progress": false,
  },
  jobs: {
    release: {
      name: "Publish & release",
      "runs-on": "ubuntu-latest",
      steps: [
        { uses: checkoutAction, with: { ref: "${{ github.sha }}" } },
        {
          uses: setupNodeAction,
          with: {
            "node-version": "24.19.0",
            "registry-url": "https://registry.npmjs.org",
          },
        },
        { uses: setupBunAction, with: { "bun-version": "1.4.0" } },
        { name: "Install dependencies", run: "bun install --frozen-lockfile" },
        {
          name: "Check the tag against the package version",
          "working-directory": "packages/collector",
          run: 'test "${GITHUB_REF_NAME#collector-v}" = "$(bun -p \'require("./package.json").version\')"',
        },
        { name: "Format & Lint (Biome)", run: "bun run format" },
        { name: "Lint anti-slop (oxlint)", run: "bun run lint:slop" },
        { name: "TypeScript check", run: "bun run check-types" },
        { name: "Test", run: "bun run test" },
        {
          name: "Test dependency policy",
          run: "bun run test:dependency-policy",
        },
        { name: "Test packed package", run: "bun run test:package" },
        {
          name: "Publish collector",
          "working-directory": "packages/collector",
          run: publishRun,
          env: { NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}" },
        },
        {
          name: "Create GitHub release",
          run: releaseRun,
          env: { GH_TOKEN: "${{ github.token }}" },
        },
      ],
    },
  },
};

const goldenFailure = "must match the reviewed release workflow exactly";

function validateWorkflow(source: string): void {
  let workflow: unknown;
  try {
    workflow = Bun.YAML.parse(source);
  } catch {
    throw new Error("Invalid release workflow YAML");
  }
  try {
    expect(workflow).toEqual(expectedWorkflow);
  } catch (cause) {
    throw new Error(
      `The release workflow ${goldenFailure}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

describe("release workflow", () => {
  it("pins the release workflow as a golden object", () => {
    expect(() => validateWorkflow(workflowSource)).not.toThrow();
  });

  it("rejects releasing from anything but a collector tag", () => {
    const mutated = workflowSource.replace(
      '    tags: ["collector-v*"]',
      '    branches: ["main"]',
    );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(goldenFailure);
  });

  it("rejects skipping the tag and version check", () => {
    const mutated = workflowSource.replace(
      "      - name: Check the tag against the package version\n",
      "      - name: Check the tag against the package version\n        if: false\n",
    );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(goldenFailure);
  });

  it("rejects publishing a version that is already on npm", () => {
    const mutated = workflowSource.replace(
      '            echo "tokenmax-collector@$version is already published"\n            exit 0\n',
      '            echo "tokenmax-collector@$version is already published"\n',
    );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(goldenFailure);
  });

  it("rejects publishing without provenance", () => {
    const mutated = workflowSource.replace(
      "npm publish --provenance --access public",
      "npm publish --access public",
    );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(goldenFailure);
  });

  it("rejects publishing with a token other than the npm secret", () => {
    const mutated = workflowSource.replace(
      "NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}",
      "NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(goldenFailure);
  });

  it("rejects widening the permissions", () => {
    const mutated = workflowSource.replace(
      "  id-token: write\n",
      "  id-token: write\n  packages: write\n",
    );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(goldenFailure);
  });

  it("rejects a release step that cannot fail", () => {
    const mutated = workflowSource.replace(
      '--title "tokenmax-collector ${GITHUB_REF_NAME#collector-v}"',
      '--title "tokenmax-collector ${GITHUB_REF_NAME#collector-v}" || true',
    );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(goldenFailure);
  });
});
