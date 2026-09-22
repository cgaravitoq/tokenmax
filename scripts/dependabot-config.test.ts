import { describe, expect, it } from "bun:test";

const dependabotPath = new URL("../.github/dependabot.yml", import.meta.url);
const autoMergePath = new URL(
  "../.github/workflows/dependabot-auto-merge.yml",
  import.meta.url,
);
const dependabotSource = await Bun.file(dependabotPath).text();
const autoMergeSource = await Bun.file(autoMergePath).text();
const collectorManifest = record(
  await Bun.file(
    new URL("../packages/collector/package.json", import.meta.url),
  ).json(),
  "collector package manifest",
);
const collectorDependencies = record(
  collectorManifest.dependencies,
  "collector dependencies",
);

const patchGate =
  "steps.metadata.outputs.update-type == 'version-update:semver-patch' && !contains(steps.metadata.outputs.dependency-names, 'ccusage')";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, context: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${context}`);
  }
  return value as UnknownRecord;
}

function parseYaml(source: string, context: string): UnknownRecord {
  try {
    return record(Bun.YAML.parse(source), context);
  } catch {
    throw new Error(`Invalid ${context} YAML`);
  }
}

function validateDependabotConfig(source: string): void {
  const config = parseYaml(source, "Dependabot config");
  const updates = config.updates;
  if (!Array.isArray(updates) || updates.length !== 2) {
    throw new Error("Dependabot must configure exactly two ecosystems");
  }
  for (const ecosystem of ["bun", "github-actions"]) {
    const update = updates.find(
      (value) =>
        record(value, "Dependabot update")["package-ecosystem"] === ecosystem,
    );
    const entry = record(update, `Dependabot ${ecosystem} update`);
    const schedule = record(entry.schedule, `Dependabot ${ecosystem} schedule`);
    const allow = entry.allow;
    if (
      entry.directory !== "/" ||
      schedule.interval !== "weekly" ||
      entry["open-pull-requests-limit"] !== 5 ||
      JSON.stringify(entry.labels) !== JSON.stringify(["dependencies"]) ||
      !Array.isArray(allow) ||
      allow.length !== 1
    ) {
      throw new Error(`Invalid Dependabot ${ecosystem} maintenance policy`);
    }
    const allowed = record(allow[0], `Dependabot ${ecosystem} allow policy`);
    if (
      allowed["dependency-type"] !== "all" ||
      JSON.stringify(allowed["update-types"]) !==
        JSON.stringify([
          "version-update:semver-patch",
          "version-update:semver-minor",
        ])
    ) {
      throw new Error(
        `Dependabot ${ecosystem} updates must stay below semver-major`,
      );
    }
    if ("ignore" in entry) {
      throw new Error("Dependabot security updates must not be ignored");
    }
  }
}

function step(steps: unknown[], index: number, context: string): UnknownRecord {
  return record(steps[index], context);
}

function validateAutoMergeWorkflow(source: string): void {
  if (
    source.includes("actions/checkout") ||
    source.includes("gh pr review") ||
    source.toLowerCase().includes("approve") ||
    source.includes("--admin") ||
    source.includes("pull_request_target")
  ) {
    throw new Error("Dependabot auto-merge contains forbidden behavior");
  }

  const workflow = parseYaml(source, "Dependabot auto-merge workflow");
  const events = record(workflow.on, "Dependabot auto-merge events");
  const pullRequest = record(events.pull_request, "pull_request event");
  if (
    JSON.stringify(pullRequest.types) !==
    JSON.stringify(["opened", "reopened", "synchronize"])
  ) {
    throw new Error("Invalid Dependabot auto-merge events");
  }

  const permissions = record(workflow.permissions, "auto-merge permissions");
  if (
    JSON.stringify(permissions) !==
    JSON.stringify({
      actions: "write",
      contents: "write",
      "pull-requests": "write",
    })
  ) {
    throw new Error("Invalid Dependabot auto-merge permissions");
  }

  const jobs = record(workflow.jobs, "auto-merge jobs");
  const job = record(jobs.dependabot, "Dependabot auto-merge job");
  const fence = typeof job.if === "string" ? job.if : "";
  for (const expected of [
    "github.actor == 'dependabot[bot]'",
    "github.repository == 'cgaravitoq/tokenmax'",
    "github.event.pull_request.base.ref == 'main'",
  ]) {
    if (!fence.includes(expected)) {
      throw new Error(`Missing Dependabot auto-merge fence: ${expected}`);
    }
  }

  if (!Array.isArray(job.steps) || job.steps.length !== 4) {
    throw new Error("Dependabot auto-merge must have exactly four steps");
  }
  if (job["timeout-minutes"] !== 20) {
    throw new Error(
      "Dependabot auto-merge must cap the wait with timeout-minutes, so a stalled run fails in minutes instead of burning the runner",
    );
  }
  const metadata = step(job.steps, 0, "Dependabot metadata step");
  if (
    metadata.id !== "metadata" ||
    "run" in metadata ||
    metadata.uses !==
      "dependabot/fetch-metadata@25dd0e34f4fe68f24cc83900b1fe3fe149efef98"
  ) {
    throw new Error("Dependabot metadata action must use the reviewed SHA");
  }

  const await_ = step(job.steps, 1, "Dependabot check-gate step");
  const awaitRun = typeof await_.run === "string" ? await_.run : "";
  if (awaitRun.includes("gh pr checks")) {
    throw new Error(
      "Dependabot auto-merge must not roll up every check on the pull request head, because that rollup includes the auto-merge run itself",
    );
  }
  const watchesHeadRun =
    awaitRun.includes("${{ github.event.pull_request.head.sha }}") &&
    awaitRun
      .split("\n")
      .some(
        (line) =>
          line.includes("gh run list") &&
          line.includes("--workflow ci.yml") &&
          line.includes('--commit "$head_sha"'),
      ) &&
    awaitRun
      .split("\n")
      .some(
        (line) =>
          line.trim() === 'gh run watch "$run_id" --exit-status --interval 20',
      );
  if (!watchesHeadRun || "continue-on-error" in await_) {
    throw new Error(
      "Dependabot auto-merge must watch the ci workflow run for the pull request head, with a failing watch that no shell fallback or continue-on-error can neutralize",
    );
  }

  const merge = step(job.steps, 2, "Dependabot merge step");
  if (merge.run !== 'gh pr merge --squash "$PR_URL"') {
    throw new Error("Dependabot auto-merge must squash merge the pull request");
  }
  if (typeof merge.run === "string" && merge.run.includes("--auto")) {
    throw new Error(
      "Dependabot auto-merge must not delegate gating to --auto, which does not block without required checks",
    );
  }

  const dispatch = step(job.steps, 3, "Dependabot dispatch step");
  const dispatchRun = typeof dispatch.run === "string" ? dispatch.run : "";
  if (
    !dispatchRun.includes("gh workflow run ci.yml") ||
    !dispatchRun.includes("--ref main")
  ) {
    throw new Error(
      "Dependabot auto-merge must dispatch CI on main, because a GITHUB_TOKEN merge raises no push event",
    );
  }

  for (const [index, gated] of [await_, merge, dispatch].entries()) {
    if (gated.if !== patchGate) {
      throw new Error(
        `Dependabot auto-merge step ${index + 1} must only arm for patches`,
      );
    }
  }
}

describe("Dependabot configuration", () => {
  it("keeps Bun and Actions weekly maintenance below semver-major", () => {
    expect(() => validateDependabotConfig(dependabotSource)).not.toThrow();
  });

  it("rejects a relaxed routine update policy", () => {
    expect(() =>
      validateDependabotConfig(
        dependabotSource.replaceAll(
          "version-update:semver-minor",
          "version-update:semver-major",
        ),
      ),
    ).toThrow("below semver-major");
  });
});

describe("Dependabot auto-merge workflow", () => {
  it("enforces events, permissions, fences, metadata, check gate, and patch squash merge", () => {
    expect(() => validateAutoMergeWorkflow(autoMergeSource)).not.toThrow();
  });

  it.each([
    ["actor", "dependabot[bot]", "renovate[bot]"],
    ["repository", "cgaravitoq/tokenmax", "someone/fork"],
    ["base", "base.ref == 'main'", "base.ref == 'staging'"],
  ])("rejects a changed %s fence", (_name, current, replacement) => {
    expect(() =>
      validateAutoMergeWorkflow(autoMergeSource.replace(current, replacement)),
    ).toThrow("Missing Dependabot auto-merge fence");
  });

  it("rejects a relaxed patch update type", () => {
    expect(() =>
      validateAutoMergeWorkflow(
        autoMergeSource.replaceAll(
          "version-update:semver-patch",
          "version-update:semver-minor",
        ),
      ),
    ).toThrow("must only arm for patches");
  });

  it("rejects dropping the ccusage exclusion from one gated step", () => {
    const withoutCcusage = autoMergeSource.replace(
      " && !contains(steps.metadata.outputs.dependency-names, 'ccusage')",
      "",
    );
    expect(withoutCcusage).not.toBe(autoMergeSource);
    expect(() => validateAutoMergeWorkflow(withoutCcusage)).toThrow(
      "must only arm for patches",
    );
  });

  it("rejects a ccusage check that misses mixed dependency groups", () => {
    expect(() =>
      validateAutoMergeWorkflow(
        autoMergeSource.replaceAll(
          "!contains(steps.metadata.outputs.dependency-names, 'ccusage')",
          "steps.metadata.outputs.dependency-names != 'ccusage'",
        ),
      ),
    ).toThrow("must only arm for patches");
  });

  it("rejects merging without waiting for the check conclusions", () => {
    const withoutGate = autoMergeSource.replace(
      / {6}- name: Await CI conclusion\n(?:.*\n)*?\n {6}- name: Squash merge/,
      "      - name: Squash merge",
    );
    expect(withoutGate).not.toContain("gh pr checks");
    expect(() => validateAutoMergeWorkflow(withoutGate)).toThrow(
      "exactly four steps",
    );
  });

  it("rejects a gate neutralized while every keyword survives", () => {
    for (const neutralized of [
      autoMergeSource.replace(
        "--exit-status --interval 20",
        "--exit-status --interval 20 || true",
      ),
      autoMergeSource.replace(
        "      - name: Squash merge",
        "        continue-on-error: true\n      - name: Squash merge",
      ),
    ]) {
      expect(neutralized).toContain("gh run watch");
      expect(neutralized).toContain("--exit-status");
      expect(() => validateAutoMergeWorkflow(neutralized)).toThrow(
        "must watch the ci workflow run for the pull request head",
      );
    }
  });

  it("rejects waiting on the whole check rollup again", () => {
    const mutated = autoMergeSource.replace(
      'gh run watch "$run_id" --exit-status --interval 20',
      'gh pr checks "$PR_URL" --watch --fail-fast --interval 20',
    );
    expect(mutated).not.toBe(autoMergeSource);
    expect(() => validateAutoMergeWorkflow(mutated)).toThrow(
      "must not roll up every check on the pull request head",
    );
  });

  it("rejects watching a run that is not the pull request head", () => {
    const mutated = autoMergeSource.replace(
      '--workflow ci.yml --commit "$head_sha"',
      "--workflow ci.yml",
    );
    expect(mutated).not.toBe(autoMergeSource);
    expect(() => validateAutoMergeWorkflow(mutated)).toThrow(
      "must watch the ci workflow run for the pull request head",
    );
  });

  it("rejects watching a workflow other than ci", () => {
    const mutated = autoMergeSource.replace(
      "--workflow ci.yml",
      "--workflow release.yml",
    );
    expect(mutated).not.toBe(autoMergeSource);
    expect(() => validateAutoMergeWorkflow(mutated)).toThrow(
      "must watch the ci workflow run for the pull request head",
    );
  });

  it("rejects a wait that can outlive the runner", () => {
    const mutated = autoMergeSource.replace("    timeout-minutes: 20\n", "");
    expect(mutated).not.toBe(autoMergeSource);
    expect(() => validateAutoMergeWorkflow(mutated)).toThrow(
      "must cap the wait with timeout-minutes",
    );
  });

  it("rejects delegating the gate back to --auto", () => {
    expect(() =>
      validateAutoMergeWorkflow(
        autoMergeSource.replace("gh pr merge --squash", "gh pr merge --auto"),
      ),
    ).toThrow("must squash merge");
  });

  it("rejects dropping the main verification dispatch", () => {
    expect(() =>
      validateAutoMergeWorkflow(
        autoMergeSource.replace("gh workflow run ci.yml", "gh run list"),
      ),
    ).toThrow("must dispatch CI on main");
  });

  it("rejects checkout", () => {
    expect(() =>
      validateAutoMergeWorkflow(
        autoMergeSource.replace(
          "steps:\n",
          "steps:\n      - uses: actions/checkout@deadbeef\n",
        ),
      ),
    ).toThrow("forbidden behavior");
  });

  it("rejects auto-approval", () => {
    expect(() =>
      validateAutoMergeWorkflow(
        autoMergeSource.replace(
          "steps:\n",
          "steps:\n      - run: gh pr review --approve\n",
        ),
      ),
    ).toThrow("forbidden behavior");
  });

  it("rejects PR-script execution", () => {
    expect(() =>
      validateAutoMergeWorkflow(
        autoMergeSource.replace(
          "id: metadata\n",
          "id: metadata\n        run: bun run build\n",
        ),
      ),
    ).toThrow("metadata action must use the reviewed SHA");
  });

  it("rejects pull_request_target", () => {
    expect(() =>
      validateAutoMergeWorkflow(
        autoMergeSource.replace("pull_request:", "pull_request_target:"),
      ),
    ).toThrow("forbidden behavior");
  });
});

describe("Collector dependency pins", () => {
  it("keeps ccusage exact, because its JSON shape is undocumented", () => {
    expect(collectorDependencies.ccusage).toBe("20.0.20");
  });
});
