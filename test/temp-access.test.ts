/**
 * Acceso al temporal de OpenCode: solo `ask` → `allow`, solo `external_directory`, y
 * solo cuando TODO lo pedido cae dentro de `<tmpdir>/opencode`. Un prefijo parecido
 * (`/tmp/opencode-x`) no cuela, y un deny nunca se toca.
 */

const APEX = new URL("..", import.meta.url).pathname.replace(/\/$/, "")
const { applyTempAccess, insideDir } = await import(`${APEX}/core/temp-access.ts`)

let passed = 0
let failed = 0
const check = (name: string, ok: boolean) => {
  if (ok) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}`)
  }
}

const DIR = "/tmp/opencode"
const run = (action: string, resources: string[], effect: "allow" | "deny" | "ask") => {
  const event = { action, resources, effect }
  applyTempAccess(event, DIR)
  return event.effect
}

console.log("temp-access")
check("el directorio y lo que cuelga", insideDir("/tmp/opencode/*", DIR) && insideDir("/tmp/opencode/a/b/*", DIR) && insideDir("/tmp/opencode", DIR))
check("un prefijo parecido no", !insideDir("/tmp/opencode-apex-advisor/*", DIR) && !insideDir("/tmp/*", DIR))
check("ask dentro → allow", run("external_directory", ["/tmp/opencode/x/*"], "ask") === "allow")
check("ask con un recurso fuera → sigue ask", run("external_directory", ["/tmp/opencode/x/*", "/etc/*"], "ask") === "ask")
check("deny dentro → sigue deny", run("external_directory", ["/tmp/opencode/*"], "deny") === "deny")
check("otra acción → sin tocar", run("edit", ["/tmp/opencode/a.txt"], "ask") === "ask")
check("sin recursos → sin tocar", run("external_directory", [], "ask") === "ask")

console.log(`\n${passed} ok, ${failed} fallos`)
if (failed) process.exit(1)
