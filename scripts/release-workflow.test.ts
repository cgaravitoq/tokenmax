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

const expectedTrigger = { push: { tags: ["collector-v*"] } };

const expectedPermissions = { contents: "write", "id-token": "write" };

const expectedConcurrency = {
  group: "release-${{ github.ref }}",
  "cancel-in-progress": false,
};

const releaseTopLevelKeys = [
  "concurrency",
  "jobs",
  "name",
  "on",
  "permissions",
];

const expectedJobKeys = ["name", "runs-on", "steps"];

interface ExpectedStep {
  uses?: string;
  name?: string;
  "working-directory"?: string;
  run?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
}

interface NamedStep {
  label: string;
  step: ExpectedStep;
}

const expectedSteps: NamedStep[] = [
  {
    label: "checkout",
    step: { uses: checkoutAction, with: { ref: "${{ github.sha }}" } },
  },
  {
    label: "setup node",
    step: {
      uses: setupNodeAction,
      with: {
        "node-version": "24.19.0",
        "registry-url": "https://registry.npmjs.org",
      },
    },
  },
  {
    label: "setup bun",
    step: { uses: setupBunAction, with: { "bun-version": "1.4.0" } },
  },
  {
    label: "Install dependencies",
    step: {
      name: "Install dependencies",
      run: "bun install --frozen-lockfile",
    },
  },
  {
    label: "Check the tag against the package version",
    step: {
      name: "Check the tag against the package version",
      "working-directory": "packages/collector",
      run: 'test "${GITHUB_REF_NAME#collector-v}" = "$(bun -p \'require("./package.json").version\')"',
    },
  },
  {
    label: "Format & Lint (Biome)",
    step: { name: "Format & Lint (Biome)", run: "bun run format" },
  },
  {
    label: "Lint anti-slop (oxlint)",
    step: { name: "Lint anti-slop (oxlint)", run: "bun run lint:slop" },
  },
  {
    label: "TypeScript check",
    step: { name: "TypeScript check", run: "bun run check-types" },
  },
  { label: "Test", step: { name: "Test", run: "bun run test" } },
  {
    label: "Test dependency policy",
    step: {
      name: "Test dependency policy",
      run: "bun run test:dependency-policy",
    },
  },
  {
    label: "Test packed package",
    step: { name: "Test packed package", run: "bun run test:package" },
  },
  {
    label: "Audit production dependencies",
    step: {
      name: "Audit production dependencies",
      run: "bun run audit:production",
    },
  },
  {
    label: "Publish collector",
    step: {
      name: "Publish collector",
      "working-directory": "packages/collector",
      run: publishRun,
      env: { NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}" },
    },
  },
  {
    label: "Create GitHub release",
    step: {
      name: "Create GitHub release",
      run: releaseRun,
      env: { GH_TOKEN: "${{ github.token }}" },
    },
  },
];

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, context: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${context}`);
  }
  return value as UnknownRecord;
}

function steps(job: UnknownRecord, context: string): UnknownRecord[] {
  if (!Array.isArray(job.steps)) {
    throw new Error(`Invalid ${context} steps`);
  }
  return job.steps.map((value, index) =>
    record(value, `${context} step ${index}`),
  );
}

function expectNamed(
  actual: unknown,
  expected: unknown,
  context: string,
): void {
  try {
    expect(actual).toEqual(expected);
  } catch (cause) {
    throw new Error(
      `The release workflow must keep the reviewed ${context}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

function validateWorkflow(source: string): void {
  let workflow: UnknownRecord;
  try {
    workflow = record(Bun.YAML.parse(source), "release workflow");
  } catch {
    throw new Error("Invalid release workflow YAML");
  }

  const topLevelKeys = Object.keys(workflow).sort();
  if (topLevelKeys.join(",") !== releaseTopLevelKeys.join(",")) {
    throw new Error(
      `The release workflow must declare exactly ${releaseTopLevelKeys.join(", ")} at the top level but declares ${topLevelKeys.join(", ")}`,
    );
  }
  expectNamed(workflow.on, expectedTrigger, "trigger");
  expectNamed(workflow.permissions, expectedPermissions, "permissions");
  expectNamed(workflow.concurrency, expectedConcurrency, "concurrency");

  const jobs = record(workflow.jobs, "release jobs");
  const jobKeys = Object.keys(jobs).sort();
  if (jobKeys.join(",") !== "release") {
    throw new Error(
      `The release workflow must declare exactly the release job but declares ${jobKeys.join(", ")}`,
    );
  }

  const job = record(jobs.release, "release job");
  const declaredJobKeys = Object.keys(job).sort();
  if (declaredJobKeys.join(",") !== expectedJobKeys.join(",")) {
    throw new Error(
      `The release job must declare exactly ${expectedJobKeys.join(", ")} but declares ${declaredJobKeys.join(", ")}`,
    );
  }
  if (job.name !== "Publish & release") {
    throw new Error("The release job must keep the reviewed name");
  }
  if (job["runs-on"] !== "ubuntu-latest") {
    throw new Error("The release job must run on ubuntu-latest");
  }

  const releaseSteps = steps(job, "release job");
  const publishIndex = releaseSteps.findIndex(
    (step) => step.name === "Publish collector",
  );
  const auditIndex = releaseSteps.findIndex(
    (step) => step.run === "bun run audit:production",
  );
  if (auditIndex === -1 || auditIndex > publishIndex) {
    throw new Error(
      "The release workflow must audit production dependencies before it publishes the tarball",
    );
  }
  if (releaseSteps.length !== expectedSteps.length) {
    throw new Error(
      `The release workflow must run exactly ${expectedSteps.length} steps but runs ${releaseSteps.length}`,
    );
  }
  expectedSteps.forEach(({ label, step }, index) => {
    try {
      expect(releaseSteps[index]).toEqual(step);
    } catch (cause) {
      throw new Error(
        `The release workflow step "${label}" must match the reviewed step: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  });
}

describe("release workflow", () => {
  it("pins every release step as a golden object", () => {
    expect(() => validateWorkflow(workflowSource)).not.toThrow();
  });

  it("rejects releasing from anything but a collector tag", () => {
    const mutated = workflowSource.replace(
      '    tags: ["collector-v*"]',
      '    branches: ["main"]',
    );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(
      "must keep the reviewed trigger",
    );
  });

  it("rejects skipping the tag and version check", () => {
    const mutated = workflowSource.replace(
      "      - name: Check the tag against the package version\n",
      "      - name: Check the tag against the package version\n        if: false\n",
    );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(
      'step "Check the tag against the package version"',
    );
  });

  it("rejects publishing a version that is already on npm", () => {
    const mutated = workflowSource.replace(
      '            echo "tokenmax-collector@$version is already published"\n            exit 0\n',
      '            echo "tokenmax-collector@$version is already published"\n',
    );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow('step "Publish collector"');
  });

  it("rejects publishing without provenance", () => {
    const mutated = workflowSource.replace(
      "npm publish --provenance --access public",
      "npm publish --access public",
    );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow('step "Publish collector"');
  });

  it("rejects publishing with a token other than the npm secret", () => {
    const mutated = workflowSource.replace(
      "NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}",
      "NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow('step "Publish collector"');
  });

  it("rejects widening the permissions", () => {
    const mutated = workflowSource.replace(
      "  id-token: write\n",
      "  id-token: write\n  packages: write\n",
    );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(
      "must keep the reviewed permissions",
    );
  });

  it("rejects a release step that cannot fail", () => {
    const mutated = workflowSource.replace(
      '--title "tokenmax-collector ${GITHUB_REF_NAME#collector-v}"',
      '--title "tokenmax-collector ${GITHUB_REF_NAME#collector-v}" || true',
    );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(
      'step "Create GitHub release"',
    );
  });

  it("rejects reordering the release steps", () => {
    const mutated = workflowSource.replace(
      "      - name: Test\n        run: bun run test\n\n      - name: Test dependency policy\n        run: bun run test:dependency-policy\n",
      "      - name: Test dependency policy\n        run: bun run test:dependency-policy\n\n      - name: Test\n        run: bun run test\n",
    );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow('step "Test"');
  });

  it("rejects dropping a gate from the release", () => {
    const mutated = workflowSource.replace(
      "      - name: Test packed package\n        run: bun run test:package\n\n",
      "",
    );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(
      "must run exactly 14 steps",
    );
  });

  it("rejects publishing without auditing production dependencies", () => {
    const mutated = workflowSource.replace(
      "      - name: Audit production dependencies\n        run: bun run audit:production\n\n",
      "",
    );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(
      "must audit production dependencies before it publishes the tarball",
    );
  });

  it("rejects auditing after the tarball is published", () => {
    const mutated = workflowSource
      .replace(
        "      - name: Audit production dependencies\n        run: bun run audit:production\n\n      - name: Publish collector\n",
        "      - name: Publish collector\n",
      )
      .replace(
        "      - name: Create GitHub release\n",
        "      - name: Audit production dependencies\n        run: bun run audit:production\n\n      - name: Create GitHub release\n",
      );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(
      "must audit production dependencies before it publishes the tarball",
    );
  });

  it("rejects an unpinned setup action", () => {
    const mutated = workflowSource.replace(
      setupBunAction,
      "oven-sh/setup-bun@v2.2.0",
    );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow('step "setup bun"');
  });

  it("rejects releasing from another runner", () => {
    const mutated = workflowSource.replace(
      "    runs-on: ubuntu-latest\n",
      "    runs-on: macos-latest\n",
    );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(
      "must run on ubuntu-latest",
    );
  });

  it("rejects a top-level key the review never approved", () => {
    const mutated = workflowSource.replace(
      "\npermissions:\n",
      '\ndefaults:\n  run:\n    shell: bash -c "exit 0; {0}"\n\npermissions:\n',
    );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(
      "must declare exactly concurrency, jobs, name, on, permissions at the top level",
    );
  });
});
