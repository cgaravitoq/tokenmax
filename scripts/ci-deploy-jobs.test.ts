import { describe, expect, it } from "bun:test";

const workflowPath = new URL("../.github/workflows/ci.yml", import.meta.url);
const workflowSource = await Bun.file(workflowPath).text();

const workflowTopLevelKeys = [
  "name",
  "on",
  "permissions",
  "concurrency",
  "jobs",
];

const workflowJobKeys = ["ci", "deploy", "publish"];

const expectedWorkflowPermissions = { contents: "read" };

const expectedWorkflowConcurrency = {
  group: "${{ github.workflow }}-${{ github.ref }}",
  "cancel-in-progress": "${{ github.ref != 'refs/heads/main' }}",
};

const expectedGate =
  "(github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/main' && needs.ci.result == 'success'";

const wranglerAction =
  "cloudflare/wrangler-action@ebbaa1584979971c8614a24965b4405ff95890e0";

const cacheAction = "actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9";

const cacheStepName = "Cache bun dependencies";

const apiTokenExpression = "${{ secrets.CLOUDFLARE_API_TOKEN }}";
const accountIdExpression = "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}";

const pinnedActionPattern = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;

const npmRegistry = "https://registry.npmjs.org";

const publishRun = `version="$(bun -p 'require("./package.json").version')"
if npm view "tokenmax-collector@$version" version; then
  echo "tokenmax-collector@$version is already published"
  exit 0
fi
npm publish --access public
`;

interface DeployApp {
  jobKey: string;
  jobName: string;
  concurrencyGroup: string;
  buildStepName: string;
  buildRun: string;
  workingDirectory: string;
  smokeRun: string;
  deployStepId?: string;
}

interface SetupActions {
  checkout: string;
  setupNode: string;
  setupBun: string;
}

const deployApps: readonly DeployApp[] = [
  {
    jobKey: "deploy",
    jobName: "Deploy worker",
    concurrencyGroup: "deploy",
    buildStepName: "Build worker",
    buildRun: "bun run build",
    workingDirectory: "apps/worker",
    smokeRun: `url="\${{ steps.deploy.outputs.deployment-url }}/api/health"\nbody="$(curl --fail --show-error --silent --retry 5 --retry-all-errors --retry-delay 5 --retry-max-time 120 --max-time 20 "$url")"\ntest "$body" = '{"ok":true}'\n`,
    deployStepId: "deploy",
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

function pinnedAction(step: UnknownRecord, context: string): string {
  const uses = step.uses;
  if (typeof uses !== "string" || !pinnedActionPattern.test(uses)) {
    throw new Error(
      `The workflow must pin ${context} to a 40-character commit SHA`,
    );
  }
  return uses;
}

interface ExpectedStep {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  "working-directory"?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
}

interface ExpectedConcurrency {
  group: string;
  "cancel-in-progress": boolean;
}

interface ExpectedDeployJob {
  name: string;
  if: string;
  needs: string;
  "runs-on": string;
  concurrency: ExpectedConcurrency;
  steps: ExpectedStep[];
}

function expectedDeployJob(
  app: DeployApp,
  actions: SetupActions,
): ExpectedDeployJob {
  const deployStep: ExpectedStep = {
    name: "Deploy Worker",
    ...(app.deployStepId ? { id: app.deployStepId } : {}),
    uses: wranglerAction,
    with: {
      apiToken: apiTokenExpression,
      accountId: accountIdExpression,
      workingDirectory: app.workingDirectory,
      packageManager: "bun",
      command: "deploy",
    },
  };
  return {
    name: app.jobName,
    if: expectedGate,
    needs: "ci",
    "runs-on": "ubuntu-latest",
    concurrency: {
      group: app.concurrencyGroup,
      "cancel-in-progress": false,
    },
    steps: [
      { uses: actions.checkout, with: { ref: "${{ github.sha }}" } },
      { uses: actions.setupNode, with: { "node-version": "24.19.0" } },
      { uses: actions.setupBun, with: { "bun-version": "1.3.14" } },
      { name: "Install dependencies", run: "bun install --frozen-lockfile" },
      { name: app.buildStepName, run: app.buildRun },
      {
        name: "Apply D1 migrations",
        "working-directory": app.workingDirectory,
        run: "bunx wrangler d1 migrations apply DB --remote",
        env: {
          CLOUDFLARE_API_TOKEN: apiTokenExpression,
          CLOUDFLARE_ACCOUNT_ID: accountIdExpression,
        },
      },
      deployStep,
      { name: "Smoke test production", run: app.smokeRun },
    ],
  };
}

function expectedPublishJob(actions: SetupActions): ExpectedDeployJob {
  return {
    name: "Publish collector",
    if: expectedGate,
    needs: "ci",
    "runs-on": "ubuntu-latest",
    concurrency: {
      group: "publish",
      "cancel-in-progress": false,
    },
    steps: [
      { uses: actions.checkout, with: { ref: "${{ github.sha }}" } },
      {
        uses: actions.setupNode,
        with: { "node-version": "24.19.0", "registry-url": npmRegistry },
      },
      { uses: actions.setupBun, with: { "bun-version": "1.3.14" } },
      { name: "Install dependencies", run: "bun install --frozen-lockfile" },
      {
        name: "Publish collector",
        "working-directory": "packages/collector",
        run: publishRun,
        env: { NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}" },
      },
    ],
  };
}

function validateWorkflow(source: string): void {
  let workflow: UnknownRecord;
  try {
    workflow = record(Bun.YAML.parse(source), "CI workflow");
  } catch {
    throw new Error("Invalid CI workflow YAML");
  }

  const topLevelKeys = Object.keys(workflow).sort();
  if (topLevelKeys.join(",") !== [...workflowTopLevelKeys].sort().join(",")) {
    throw new Error(
      `The CI workflow must declare exactly ${[...workflowTopLevelKeys].sort().join(", ")} at the top level but declares ${topLevelKeys.join(", ")}`,
    );
  }
  expectTopLevel(
    workflow.permissions,
    expectedWorkflowPermissions,
    "permissions",
  );
  expectTopLevel(
    workflow.concurrency,
    expectedWorkflowConcurrency,
    "concurrency",
  );

  const jobs = record(workflow.jobs, "CI jobs");
  const jobKeys = Object.keys(jobs).sort();
  if (jobKeys.join(",") !== [...workflowJobKeys].sort().join(",")) {
    throw new Error(
      `The CI workflow must declare exactly ${[...workflowJobKeys].sort().join(", ")} jobs but declares ${jobKeys.join(", ")}`,
    );
  }
  validateCachedDependencies(jobs);

  const deploySteps = steps(record(jobs.deploy, "deploy job"), "deploy job");
  const actions: SetupActions = {
    checkout: pinnedAction(deploySteps[0], "the checkout action"),
    setupNode: pinnedAction(deploySteps[1], "the setup-node action"),
    setupBun: pinnedAction(deploySteps[2], "the setup-bun action"),
  };

  for (const app of deployApps) {
    const job = record(jobs[app.jobKey], `${app.jobKey} job`);
    try {
      expect(job).toEqual(expectedDeployJob(app, actions));
    } catch (cause) {
      throw new Error(
        `Job ${app.jobKey} must match the reviewed deploy job exactly: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  try {
    expect(record(jobs.publish, "publish job")).toEqual(
      expectedPublishJob(actions),
    );
  } catch (cause) {
    throw new Error(
      `Job publish must match the reviewed publish job exactly: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

function validateCachedDependencies(jobs: UnknownRecord): void {
  const ciSteps = steps(record(jobs.ci, "ci job"), "ci job");
  const cacheStep = ciSteps.find((step) => step.name === cacheStepName);
  if (!cacheStep) {
    throw new Error(`The ci job must keep the ${cacheStepName} step`);
  }
  if (pinnedAction(cacheStep, "the cache action") !== cacheAction) {
    throw new Error(`The ci job must pin the cache action to ${cacheAction}`);
  }
}

function expectTopLevel(
  actual: unknown,
  expected: UnknownRecord,
  context: string,
): void {
  try {
    expect(actual).toEqual(expected);
  } catch (cause) {
    throw new Error(
      `The CI workflow must keep the reviewed top-level ${context}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

const goldenFailure = "must match the reviewed deploy job exactly";

describe("CI deploy jobs", () => {
  it("pins the deploy job as a golden object", () => {
    expect(() => validateWorkflow(workflowSource)).not.toThrow();
  });

  it("rejects a relaxed needs.ci result gate", () => {
    const mutated = workflowSource.replace(
      "needs.ci.result == 'success'",
      "needs.ci.result != 'failure'",
    );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(goldenFailure);
  });

  it("rejects dropping the ci dependency", () => {
    const cut = workflowSource.indexOf("  deploy:\n");
    const mutated =
      workflowSource.slice(0, cut) +
      workflowSource.slice(cut).replace("    needs: ci\n", "");
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(
      `Job deploy ${goldenFailure}`,
    );
  });

  it("rejects cancelling a deployment in progress", () => {
    const mutated = workflowSource.replace(
      "cancel-in-progress: false",
      "cancel-in-progress: true",
    );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(goldenFailure);
  });

  it("rejects migrating the wrong directory", () => {
    const mutated = workflowSource.replace(
      "        working-directory: apps/worker",
      "        working-directory: apps/web",
    );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(
      `Job deploy ${goldenFailure}`,
    );
  });

  it("rejects an unreviewed wrangler action SHA", () => {
    const mutated = workflowSource.replace(
      "wrangler-action@ebbaa1584979971c8614a24965b4405ff95890e0",
      "wrangler-action@ebbaa1584979971c8614a24965b4405ff95890e1",
    );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(goldenFailure);
  });

  it("rejects smoke testing a path other than the health endpoint", () => {
    const mutated = workflowSource.replace(
      "deployment-url }}/api/health",
      "deployment-url }}/",
    );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(
      `Job deploy ${goldenFailure}`,
    );
  });

  it("rejects skipping the worker migration step", () => {
    const mutated = workflowSource.replace(
      "      - name: Apply D1 migrations\n        working-directory: apps/worker\n",
      "      - name: Apply D1 migrations\n        if: false\n        working-directory: apps/worker\n",
    );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(
      `Job deploy ${goldenFailure}`,
    );
  });

  it("rejects appending a second deploy step", () => {
    const mutated = workflowSource.replace(
      "      - name: Smoke test production\n",
      "      - name: Deploy Worker\n        uses: cloudflare/wrangler-action@ebbaa1584979971c8614a24965b4405ff95890e0\n\n      - name: Smoke test production\n",
    );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(goldenFailure);
  });

  it("rejects a smoke test that cannot fail", () => {
    const mutated = workflowSource.replace(
      `test "$body" = '{"ok":true}'`,
      `test "$body" = '{"ok":true}' || true`,
    );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(
      `Job deploy ${goldenFailure}`,
    );
  });

  it("rejects reflowing the smoke test onto a single line", () => {
    const mutated = workflowSource.replace(
      `        run: |\n          url="\${{ steps.deploy.outputs.deployment-url }}/api/health"\n`,
      `        run: |\n          url="\${{ steps.deploy.outputs.deployment-url }}/api/health";\n`,
    );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(
      `Job deploy ${goldenFailure}`,
    );
  });

  it("rejects job-level defaults that neutralise every run step", () => {
    const mutated = workflowSource.replace(
      "  deploy:\n    name: Deploy worker\n",
      '  deploy:\n    name: Deploy worker\n    defaults:\n      run:\n        shell: bash -c "exit 0; {0}"\n',
    );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(
      `Job deploy ${goldenFailure}`,
    );
  });

  it("rejects a job-level env block", () => {
    const mutated = workflowSource.replace(
      "  deploy:\n    name: Deploy worker\n",
      '  deploy:\n    name: Deploy worker\n    env:\n      CI: "true"\n',
    );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(
      `Job deploy ${goldenFailure}`,
    );
  });

  it("rejects an unreviewed wrangler version input", () => {
    const mutated = workflowSource.replace(
      "          workingDirectory: apps/worker\n",
      '          workingDirectory: apps/worker\n          wranglerVersion: "4.0.0"\n',
    );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(
      `Job deploy ${goldenFailure}`,
    );
  });

  it("rejects an unreviewed node version on the deploy job", () => {
    const cut = workflowSource.indexOf("  deploy:\n");
    const mutated =
      workflowSource.slice(0, cut) +
      workflowSource
        .slice(cut)
        .replace('node-version: "24.19.0"', 'node-version: "18"');
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(
      `Job deploy ${goldenFailure}`,
    );
  });

  it("rejects an unpinned cache action in the ci job", () => {
    const mutated = workflowSource.replace(cacheAction, "actions/cache@v6");
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(
      "must pin the cache action to a 40-character commit SHA",
    );
  });

  it("rejects installing without the frozen lockfile", () => {
    const cut = workflowSource.indexOf("  deploy:\n");
    const mutated =
      workflowSource.slice(0, cut) +
      workflowSource
        .slice(cut)
        .replace("run: bun install --frozen-lockfile", "run: bun install");
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(
      `Job deploy ${goldenFailure}`,
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

  it("rejects widening the top-level permissions", () => {
    const mutated = workflowSource.replace(
      "\npermissions:\n  contents: read\n",
      "\npermissions:\n  contents: write\n",
    );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(
      "must keep the reviewed top-level permissions",
    );
  });

  it("rejects an extra job the review never approved", () => {
    const mutated = `${workflowSource}\n  deploy-twice:\n    name: Deploy worker\n`;
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(
      "must declare exactly ci, deploy, publish jobs",
    );
  });

  it("rejects publishing a version that is already on npm", () => {
    const mutated = workflowSource.replace(
      '            echo "tokenmax-collector@$version is already published"\n            exit 0\n',
      '            echo "tokenmax-collector@$version is already published"\n',
    );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(
      "Job publish must match the reviewed publish job exactly",
    );
  });

  it("rejects publishing from a branch other than main", () => {
    const cut = workflowSource.indexOf("  publish:\n");
    const mutated =
      workflowSource.slice(0, cut) +
      workflowSource
        .slice(cut)
        .replace("github.ref == 'refs/heads/main'", "github.ref != ''");
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(
      "Job publish must match the reviewed publish job exactly",
    );
  });

  it("rejects publishing with a token other than the npm secret", () => {
    const mutated = workflowSource.replace(
      "NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}",
      "NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    );
    expect(mutated).not.toBe(workflowSource);
    expect(() => validateWorkflow(mutated)).toThrow(
      "Job publish must match the reviewed publish job exactly",
    );
  });
});
