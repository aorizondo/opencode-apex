# Keeping a relay or watcher running (Linux, macOS, Windows, containers)

Requirements on every OS:
- **Relays:** start at boot or login, restart on crash, keep logs.
- **Watchers:** a scheduler that runs them every N minutes.
- Run as the **same user as OpenCode**, so the program can read the password record named by `apex_callback_endpoint`.
- Configuration goes in a file or environment file with mode `0600`, never in the unit or command line. Process lists are visible to other users.
- Tell the user how to see logs, stop it and remove it.

Below, `RELAY` stands for the command that starts your program, for example `python3 ~/.local/bin/my-relay.py` or `node ~/.local/bin/my-relay.mjs`.

## Linux — systemd user units

```ini
# ~/.config/systemd/user/my-relay.service
[Unit]
Description=apex relay: my-relay
After=network-online.target

[Service]
ExecStart=/usr/bin/python3 %h/.local/bin/my-relay.py
# mode 0600, KEY=value lines (systemd has no end-of-line comments)
EnvironmentFile=%h/.config/my-relay/env
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload && systemctl --user enable --now my-relay
journalctl --user -u my-relay -f                    # logs
loginctl enable-linger "$USER"                      # keep running without an open login session (ask the user first)
```

Watcher: a `Type=oneshot` service plus a timer.

```ini
# ~/.config/systemd/user/my-watch.timer   (my-watch.service: Type=oneshot, ExecStart=…)
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
```

`systemctl --user enable --now my-watch.timer`, then check with `systemctl --user list-timers`. Without systemd, use `crontab -e`: `*/5 * * * * <command> >> ~/.local/state/my-watch.log 2>&1`.

Remove it: `systemctl --user disable --now my-relay`, then delete the unit and the script.

## macOS — launchd LaunchAgent

```xml
<!-- ~/Library/LaunchAgents/com.user.my-relay.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.user.my-relay</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/python3</string><string>/Users/USER/.local/bin/my-relay.py</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>                    <!-- relay: restart when it exits -->
  <!-- watcher instead: drop KeepAlive and add <key>StartInterval</key><integer>300</integer> -->
  <key>StandardOutPath</key><string>/Users/USER/Library/Logs/my-relay.log</string>
  <key>StandardErrorPath</key><string>/Users/USER/Library/Logs/my-relay.log</string>
</dict></plist>
```

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.user.my-relay.plist
launchctl kickstart -k gui/$(id -u)/com.user.my-relay      # restart after changes
launchctl bootout gui/$(id -u)/com.user.my-relay           # stop and unload
```

- launchd does not expand `~` or `$HOME`: write absolute paths.
- Environment variables go in an `EnvironmentVariables` dict, or better, the program reads its own `0600` config file.
- The `PATH` is minimal, so call interpreters by their full path (`which python3`).

## Windows — Task Scheduler (no extra software)

```powershell
# relay: start at logon, restart on failure, never time out
$action   = New-ScheduledTaskAction -Execute "python.exe" -Argument "$env:USERPROFILE\relays\my-relay.py"
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
            -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "my-relay" -Action $action -Trigger $trigger -Settings $settings
Start-ScheduledTask -TaskName "my-relay"

# watcher: every 5 minutes
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName "my-watch" -Action $action -Trigger $trigger -Settings $settings

Unregister-ScheduledTask -TaskName "my-relay" -Confirm:$false     # remove
```

- Task Scheduler keeps no output, so the program writes its own log under `%LOCALAPPDATA%\my-relay\`. Wrap the command in `powershell -NoProfile -WindowStyle Hidden -Command "… *>> log.txt"` if it cannot.
- Use `pythonw.exe` (or a hidden PowerShell window) to avoid a console window popping up.
- To run before anyone logs in, a Windows service via **NSSM** (`nssm install my-relay <exe> <args>`) or **WinSW**, but check which account it runs as. A service running as `LocalSystem` cannot read the user's OpenCode password file unless configured to run as that user.

## Containers (Docker / Podman)

```sh
# --network host: on Linux, OpenCode is on the host's 127.0.0.1
# first -v: the folder of the password record named by apex_callback_endpoint (read-only)
docker run -d --name my-relay --restart unless-stopped \
  --network host \
  -v ~/.local/state/opencode:/opencode-state:ro \
  -v ~/.config/my-relay:/config:ro \
  my-relay-image
```

- A container on the default bridge network **cannot reach the host's `127.0.0.1`**. On Linux use `--network host`.
- On Docker Desktop (macOS/Windows), `host.docker.internal` reaches the host. The `rpc.*` URLs then use that host instead of `127.0.0.1`.
- Inside the container, the password-file path differs from the host's. Pass the mounted path to the program.
- Containers only make sense if the user already runs Docker on that machine. A user service is simpler.

## Any OS with Node — pm2

```sh
npm install -g pm2
pm2 start ~/.local/bin/my-relay.mjs --name my-relay      # also: pm2 start my-relay.py --interpreter python3
pm2 save && pm2 startup                                  # prints the command that enables start at boot
pm2 logs my-relay        pm2 delete my-relay
```

## After installing

1. Check it is running (`systemctl --user status`, `launchctl print gui/$(id -u)/<label>`, `Get-ScheduledTask`, `docker ps`, `pm2 ls`).
2. Reboot or log out and back in, if the user agrees, and check it came back.
3. Write down for the user: the name, the log location, the stop and remove commands, and the subscription id.
