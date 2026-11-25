/**
 * Autoarranque del daemon tras reiniciar el equipo, sin systemd ni launchd:
 * - Linux / macOS / BSD: una línea `@reboot` en el crontab del usuario (vale con
 *   cualquier init: systemd, sysvinit, runit, OpenRC…).
 * - Windows: una tarea programada al iniciar sesión (`schtasks /SC ONLOGON`).
 *
 * Lo que se arranca es el lanzador (`launch.sh` / `launch.cmd`) que el plugin reescribe
 * con las rutas actuales cada vez que lanza el daemon, así una actualización de OpenCode
 * o de apex no deja el autoarranque apuntando a un binario que ya no existe.
 */

import { spawnSync } from "node:child_process"
import { daemonPaths, type DaemonPaths } from "../daemon/shared.js"

export const CRON_MARKER = "# opencode-apex-daemon"
export const TASK_NAME = "opencode-apex-daemon"

export interface AutostartStatus {
  readonly enabled: boolean
  readonly method: "crontab" | "schtasks"
  readonly detail?: string
}

/** El crontab con (o sin) la línea de apex, sin tocar el resto. */
export function editCrontab(current: string, launcher: string, enable: boolean): string {
  const kept = current.split("\n").filter((line) => !line.includes(CRON_MARKER))
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop()
  if (enable) kept.push(`@reboot /bin/sh '${launcher.replaceAll("'", `'\\''`)}' ${CRON_MARKER}`)
  return kept.length > 0 ? `${kept.join("\n")}\n` : ""
}

function run(command: string, args: string[], input?: string) {
  const result = spawnSync(command, args, { encoding: "utf8", input, windowsHide: true })
  return { ok: result.status === 0, out: result.stdout ?? "", err: (result.stderr ?? "") || (result.error?.message ?? "") }
}

export function autostartStatus(paths: DaemonPaths = daemonPaths()): AutostartStatus {
  if (process.platform === "win32") {
    const query = run("schtasks", ["/Query", "/TN", TASK_NAME])
    return { enabled: query.ok, method: "schtasks" }
  }
  const list = run("crontab", ["-l"])
  return {
    enabled: list.ok && list.out.split("\n").some((line) => line.includes(CRON_MARKER) && line.includes(paths.launcher)),
    method: "crontab",
  }
}

export function setAutostart(enable: boolean, paths: DaemonPaths = daemonPaths()): AutostartStatus {
  if (process.platform === "win32") {
    const result = enable
      ? run("schtasks", ["/Create", "/TN", TASK_NAME, "/TR", `"${paths.launcher}"`, "/SC", "ONLOGON", "/RL", "LIMITED", "/F"])
      : run("schtasks", ["/Delete", "/TN", TASK_NAME, "/F"])
    if (!result.ok && enable) throw new Error(`schtasks failed: ${result.err.trim()}`)
    return autostartStatus(paths)
  }
  const list = run("crontab", ["-l"])
  // Sin crontab previo, `crontab -l` falla con "no crontab for <user>": se parte de vacío.
  if (!list.ok && !/no crontab/i.test(list.err)) {
    if (/ENOENT|not found/i.test(list.err)) throw new Error("crontab is not installed (install cron, e.g. apt install cron)")
    throw new Error(`crontab -l failed: ${list.err.trim()}`)
  }
  const next = editCrontab(list.ok ? list.out : "", paths.launcher, enable)
  const write = next.length > 0 ? run("crontab", ["-"], next) : run("crontab", ["-r"])
  if (!write.ok && next.length > 0) throw new Error(`crontab write failed: ${write.err.trim()}`)
  return { ...autostartStatus(paths), detail: "runs at boot via cron @reboot (any init system)" }
}
