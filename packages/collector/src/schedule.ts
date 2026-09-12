export interface ScheduleOptions {
  cliPath: string;
  execPath: string;
  stderrLog: string;
  stdoutLog: string;
}

export type SupportedPlatform = "darwin" | "linux";

export function launchAgentPlist(options: ScheduleOptions): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.tokenmax.collector</string>
  <key>ProgramArguments</key>
  <array>
    <string>${options.execPath}</string>
    <string>${options.cliPath}</string>
    <string>collect</string>
  </array>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${options.stdoutLog}</string>
  <key>StandardErrorPath</key>
  <string>${options.stderrLog}</string>
</dict>
</plist>
`;
}

export function systemdService(options: ScheduleOptions): string {
  return `[Unit]
Description=Report local token usage to tokenmax

[Service]
Type=oneshot
ExecStart="${options.execPath}" "${options.cliPath}" collect
`;
}

export function systemdTimer(): string {
  return `[Unit]
Description=Report local token usage to tokenmax every five minutes

[Timer]
Unit=tokenmax.service
OnBootSec=1min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
`;
}

export function loadCommand(
  platform: SupportedPlatform,
  plistPath: string,
  uid: number,
): string {
  return platform === "darwin"
    ? `launchctl bootstrap gui/${uid} ${plistPath}`
    : "systemctl --user enable --now tokenmax.timer";
}
