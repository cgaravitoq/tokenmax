# tokenmax

Self-hostable token-usage service: a Cloudflare Worker that stores daily per-provider and per-model counts reported by a local collector, and serves a public per-login summary.

Extracted from cgaravitoq/portfolio-monorepo at 69ebf6a on 2026-09-12.

## Worker

The self-host guide lands with the worker import.

## Collector

The collector requires Bun 1.3.14 or newer and supports macOS and Linux.
Windows is unsupported.

Once the package is published, install it globally and create the local schedule:

```bash
bun add -g tokenmax-collector
tokenmax install --url <url> --key <key>
```

Pass `--timezone <zone>` to `install` to override the machine's IANA timezone.
Non-dry `tokenmax install` refuses Bun paths containing `/install/cache/` or a `bunx-<digits>-<package>` directory segment because those paths can disappear while a schedule still points to them.
Run `tokenmax collect` to report the last 14 calendar days immediately.

To upgrade, reinstall the latest package and regenerate the schedule with the existing key:

```bash
bun add -g tokenmax-collector@latest
tokenmax install --url <url> --key <existing-key>
```

On macOS, run `launchctl bootout gui/<uid>/dev.tokenmax.collector`, then run the printed `launchctl bootstrap` command.
On Linux, run `systemctl --user daemon-reload`, then run the printed `systemctl --user enable --now tokenmax.timer` command.
