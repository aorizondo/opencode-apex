#!/usr/bin/env node
// Instala el paquete tal como lo hace OpenCode (npm, sin scripts) en un directorio
// temporal y comprueba que funcionará: UNA sola copia de `effect` (la de
// @opencode/plugin) y que el plugin se importa. Corre en prepublishOnly, así una
// subida de versión de OpenCode que desalinee dependencias no llega a publicarse.
import { execFileSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = new URL("..", import.meta.url).pathname
const work = mkdtempSync(join(tmpdir(), "apex-install-"))
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" })
let ok = true
const fail = (msg) => {
  ok = false
  console.error(`✗ ${msg}`)
}

try {
  const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", work], root))[0]
  const tarball = join(work, packed.filename)
  const app = join(work, "app")
  run("mkdir", ["-p", app])
  writeFileSync(join(app, "package.json"), "{}")
  run("npm", ["install", tarball, "--ignore-scripts", "--no-audit", "--no-fund"], app)

  // Todas las copias de effect instaladas (node_modules/effect a cualquier profundidad).
  const copies = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(dir, entry.name)
      if (entry.name === "effect" && existsSync(join(path, "package.json"))) {
        copies.push(`${path.slice(app.length + 1)}@${JSON.parse(readFileSync(join(path, "package.json"), "utf8")).version}`)
      }
      if (entry.name === "node_modules" || entry.name.startsWith("@") || dir.endsWith("node_modules")) walk(path)
    }
  }
  walk(join(app, "node_modules"))
  const plugin = JSON.parse(readFileSync(join(app, "node_modules/@opencode/plugin/package.json"), "utf8")).version
  console.log(`@opencode/plugin ${plugin} · effect: ${copies.join(", ") || "(ninguna)"}`)
  if (copies.length !== 1) fail(`se esperaba una sola copia de effect, hay ${copies.length}`)

  const entry = join(app, "node_modules/opencode-apex/index.ts")
  const probe = `const m = await import(${JSON.stringify(entry)}); if (m.default?.id !== "apex" || typeof m.default.effect !== "function") process.exit(3)`
  try {
    run("bun", ["-e", probe], app)
    console.log("✓ el plugin se importa desde la instalación npm")
  } catch (error) {
    fail(`el plugin no se importa: ${String(error.stderr || error.message).trim().split("\n").slice(-3).join(" | ")}`)
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(ok ? "✅ instalación compatible" : "❌ instalación incompatible")
process.exit(ok ? 0 : 1)
