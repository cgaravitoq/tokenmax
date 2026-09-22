# tokenmax-collector

Report local token usage to a [tokenmax](https://github.com/cgaravitoq/tokenmax) instance.

The collector requires Bun 1.4.0 or newer, which ships `node:sqlite`, and supports macOS and Linux.
Windows is unsupported, and npm refuses the install there.

## Install

```bash
bun add -g tokenmax-collector
tokenmax install --url <url> --key <key>
```

`install` writes `~/.config/tokenmax/config.json` with mode 600 and a launchd agent on macOS or a systemd user timer on Linux that runs `tokenmax collect` every five minutes.
Pass `--timezone <zone>` to override the machine's IANA timezone, or `--dry-run` to print the files without writing them.
Non-dry `install` refuses Bun paths containing `/install/cache/` or a `bunx-<digits>-<package>` directory segment, because those paths can disappear while a schedule still points to them.

Running `install` with a new url adds a target and keeps the existing ones, and running it again with a configured url replaces that target's key, so one machine can feed a personal instance and a team board at once.
The config is `{ "targets": [{ "url": "...", "key": "..." }], "timezone": "..." }`, and the single-target shape written before targets existed still reads.

## Report

`tokenmax collect` reports the last 14 calendar days to `POST /api/report` of every configured target.
The rows come from ccusage for every agent it detects, plus two sources ccusage has no adapter for: the Antigravity CLI conversations under `~/.gemini/antigravity-cli/conversations`, reported as `antigravity`, and the Devin CLI transcripts under `~/.local/share/devin/cli/transcripts`, reported as `devin` with the effort suffix of each model collapsed into its LiteLLM name.
Both are priced from the LiteLLM table cached for a day at `~/.config/tokenmax/litellm-prices.json`.

`collect` prints one `accepted <n> days for <machine> at <url>` line per target, where `<n>` is the number of usage rows the instance stored rather than a count of calendar days, and exits 1 when any target rejects the report.

## Upgrade

```bash
bun add -g tokenmax-collector@latest
tokenmax install --url <url> --key <existing-key>
```

On macOS, run `launchctl bootout gui/<uid>/dev.tokenmax.collector`, then run the printed `launchctl bootstrap` command.
On Linux, run `systemctl --user daemon-reload`, then run the printed `systemctl --user enable --now tokenmax.timer` command.
