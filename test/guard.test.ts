/**
 * Motor de meta-permisos: la tabla de decisión y la expansión de recursos.
 *
 * Es la pieza que decide si un agente puede tocar algo, así que un fallo aquí no
 * se nota hasta que ya ha dejado pasar lo que debía frenar. De ahí la tabla.
 */

const APEX = new URL("..", import.meta.url).pathname.replace(/\/$/, "")

const { decide, matches, expandResource, policyFor, GuardReport, ruleLabel } = await import(
  `${APEX}/core/guard.ts`
)

let passed = 0
let failed = 0
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
  }
}

const PATHS = { projectDir: "/proy", home: "/home/ant" }

const cfg = (agents: Record<string, unknown[]>, extra: Record<string, unknown> = {}) =>
  ({ mode: "enforce", fallback: "ask", keep: 100, agents, ...extra }) as never

// ===========================================================================
console.log("\n1. Coincidencia de patrones")
// ===========================================================================

check("* cubre todo", matches("*", "cualquier/cosa"))
check("exacto", matches("shell", "shell") && !matches("shell", "shellx"))
check("prefijo con comodín", matches("hindsight_*", "hindsight_reflect"))
check("no cruza de nombre", !matches("hindsight_*", "apex_guard_report"))
check("comodín en medio", matches("rm -rf *", "rm -rf /tmp/x"))
check("el comodín cruza barras", matches(".opencode/*", ".opencode/a/b/c"))
check("los puntos no son comodín", !matches("a.b", "axb"))
check("un patrón de ruta no coincide con otra rama", !matches("/proy/.opencode/x/*", "/proy/src/main.ts"))
// Un comando multilínea es un solo recurso: el patrón debe alcanzarlo.
check("el comodín abarca saltos de línea", matches("git *", "git commit -m 'uno\ndos'"))

// ===========================================================================
console.log("\n2. Expansión de recursos")
// ===========================================================================

check("relativo → proyecto", expandResource(".opencode/scout/**", "/proy", "/home/ant") === "/proy/.opencode/scout/**")
check("absoluto intacto", expandResource("/etc/passwd", "/proy", "/home/ant") === "/etc/passwd")
check("~ → home", expandResource("~/.ssh/*", "/proy", "/home/ant") === "/home/ant/.ssh/*")
check("* se queda en *", expandResource("*", "/proy", "/home/ant") === "*")
// Un comando de shell no es una ruta; expandirlo lo rompería.
check("comando con espacios intacto", expandResource("rm -rf *", "/proy", "/home/ant") === "rm -rf *")
check("barra final del proyecto no duplica", expandResource("x", "/proy/", "/home/ant") === "/proy/x")

// ===========================================================================
console.log("\n3. Sin reglas")
// ===========================================================================

{
  const d = decide(cfg({}), { agent: "a", action: "write", resources: ["/proy/x"], incoming: "ask" }, PATHS)
  check("cae al fallback", d.effect === "ask", d.effect)
  check("y lo dice", /ninguna regla/.test(d.reason ?? ""), d.reason)
  check("conserva el efecto de entrada", d.incoming === "ask")
}

{
  const d = decide(cfg({}, { fallback: "deny" }), { agent: "a", action: "write", resources: ["/proy/x"], incoming: "ask" }, PATHS)
  check("un fallback deny cierra por defecto", d.effect === "deny")
}

{
  // "keep" respeta lo que decidió el host. Es el único default seguro: con
  // `fallback: "allow"` el guard elevaba a allow TODOS los ask, anulando las
  // reglas de shell de la config y dejando al advisor sin nada que juzgar — un
  // `rm -r` llegó a ejecutarse sin preguntar.
  const c = cfg({}, { fallback: "keep" })
  const pide = decide(c, { agent: "a", action: "shell", resources: ["rm -r x"], incoming: "ask" }, PATHS)
  check("keep no toca un ask", pide.effect === "ask", pide.effect)
  const pasa = decide(c, { agent: "a", action: "read", resources: ["x"], incoming: "allow" }, PATHS)
  check("keep no toca un allow", pasa.effect === "allow", pasa.effect)
}

// ===========================================================================
console.log("\n4. La base * y el agente")
// ===========================================================================

{
  const c = cfg({
    "*": [{ action: "*", effect: "allow" }],
    escriba: [{ action: "shell", effect: "deny", reason: "sin shell" }],
  })
  const base = decide(c, { agent: "otro", action: "shell", resources: ["ls"], incoming: "ask" }, PATHS)
  check("otro agente hereda la base", base.effect === "allow", base.effect)

  const propio = decide(c, { agent: "escriba", action: "shell", resources: ["ls"], incoming: "ask" }, PATHS)
  check("el agente afina la base", propio.effect === "deny", propio.effect)
  check("con su motivo", propio.reason === "sin shell")
  check("las reglas del agente van después", policyFor(c, "escriba").at(-1)?.action === "shell")
}

// ===========================================================================
console.log("\n5. Última coincidencia gana: «nada, salvo esta ruta»")
// ===========================================================================

{
  // El caso que motiva el módulo: solo lectura, salvo su propio directorio.
  const c = cfg({
    scout: [
      { action: "*", effect: "deny", reason: "scout es de solo lectura" },
      { action: "read", effect: "allow" },
      { action: "glob", effect: "allow" },
      { action: "grep", effect: "allow" },
      { action: "edit", resource: ".opencode/scout/**", effect: "allow" },
      { action: "write", resource: ".opencode/scout/**", effect: "allow" },
    ],
  })
  const q = (action: string, resource: string) =>
    decide(c, { agent: "scout", action, resources: [resource], incoming: "ask" }, PATHS)

  check("lee donde quiera", q("read", "/proy/src/a.ts").effect === "allow")
  check("busca donde quiera", q("grep", "/proy/src").effect === "allow")
  check("NO edita el proyecto", q("edit", "/proy/src/a.ts").effect === "deny", q("edit", "/proy/src/a.ts").effect)
  check("sí edita su directorio", q("edit", "/proy/.opencode/scout/notas.md").effect === "allow")
  check("sí escribe en su directorio", q("write", "/proy/.opencode/scout/informe.md").effect === "allow")
  check("no escribe en el de otro", q("write", "/proy/.opencode/otro/x.md").effect === "deny")
  check("ni shell", q("shell", "ls").effect === "deny")
  check("el deny amplio conserva su motivo", q("shell", "ls").reason === "scout es de solo lectura")
  check("la decisión nombra la regla", ruleLabel(q("edit", "/proy/.opencode/scout/n.md").rule) === "allow edit .opencode/scout/**")

  // El host entrega el recurso relativo al cwd en unas tools y absoluto en
  // otras: medido, `read` llega como "package.json". Una regla escrita en
  // relativo tiene que valer para las dos formas.
  check("recurso RELATIVO también coincide", q("edit", ".opencode/scout/notas.md").effect === "allow",
    q("edit", ".opencode/scout/notas.md").effect)
  check("y el relativo ajeno sigue denegado", q("edit", "src/a.ts").effect === "deny",
    q("edit", "src/a.ts").effect)
  check("lectura con ruta relativa", q("read", "package.json").effect === "allow")
}

// ===========================================================================
console.log("\n6. El agente advisor")
// ===========================================================================

{
  // Su política por defecto, la que impide que su propio modelo toque nada.
  const c = cfg({
    "apex-advisor": [
      { action: "*", effect: "deny", reason: "el advisor solo decide" },
      { action: "execute", effect: "allow" },
      { action: "apex_advisor_decide", effect: "allow" },
    ],
  })
  const q = (action: string) =>
    decide(c, { agent: "apex-advisor", action, resources: ["*"], incoming: "ask" }, PATHS)

  // `execute` es imprescindible: opencode v2 llama las tools desde el sandbox JS.
  check("execute permitido", q("execute").effect === "allow")
  check("su tool de decisión permitida", q("apex_advisor_decide").effect === "allow")
  check("write BLOQUEADO", q("write").effect === "deny", q("write").effect)
  check("edit bloqueado", q("edit").effect === "deny")
  check("shell bloqueado", q("shell").effect === "deny")
  check("subagent bloqueado", q("subagent").effect === "deny")
}

// ===========================================================================
console.log("\n7. Varios recursos en una sola evaluación")
// ===========================================================================

{
  const c = cfg({ a: [{ action: "*", effect: "allow" }, { action: "read", resource: "~/.ssh/*", effect: "deny" }] })
  const limpio = decide(c, { agent: "a", action: "read", resources: ["/proy/x", "/proy/y"], incoming: "ask" }, PATHS)
  check("todos fuera del patrón → allow", limpio.effect === "allow")

  // Basta UNO que encaje en la regla prohibida para que decida.
  const sucio = decide(c, { agent: "a", action: "read", resources: ["/proy/x", "/home/ant/.ssh/id_rsa"], incoming: "ask" }, PATHS)
  check("uno prohibido decide", sucio.effect === "deny", sucio.effect)
  check("y señala cuál", sucio.resource === "/home/ant/.ssh/id_rsa", String(sucio.resource))
}

{
  // Un permiso sin recursos sigue siendo evaluable (question, websearch…).
  const c = cfg({ a: [{ action: "question", effect: "allow" }] })
  const d = decide(c, { agent: "a", action: "question", resources: [], incoming: "ask" }, PATHS)
  check("sin recursos se trata como *", d.effect === "allow", d.effect)
}

// ===========================================================================
console.log("\n8. Agente ausente")
// ===========================================================================

{
  const c = cfg({ "*": [{ action: "*", effect: "allow" }] })
  const d = decide(c, { agent: undefined, action: "read", resources: ["/proy/x"], incoming: "allow" }, PATHS)
  check("sin agente aplica solo la base", d.effect === "allow")
  check("y no revienta", typeof d.effect === "string")
}

// ===========================================================================
console.log("\n9. El informe")
// ===========================================================================

{
  const r = new GuardReport(3)
  const mk = (agent: string, applied: string) =>
    ({ at: 1, agent, action: "write", resources: [], incoming: "ask", effect: applied, applied }) as never
  r.add(mk("a", "deny"))
  r.add(mk("a", "deny"))
  r.add(mk("b", "allow"))
  check("guarda lo añadido", r.all().length === 3)

  r.add(mk("b", "ask"))
  check("el anillo no crece del límite", r.all().length === 3, String(r.all().length))
  check("descarta lo más viejo", r.all()[0]?.agent === "a" && r.all().filter((e: { agent: string }) => e.agent === "a").length === 1)

  const s = r.summary()
  check("resume por agente y efecto", s["b"]?.allow === 1 && s["b"]?.ask === 1, JSON.stringify(s))
  check("lo reciente va primero", r.recent(2)[0]?.applied === "ask")
  r.clear()
  check("se puede vaciar", r.all().length === 0)
}

// ===========================================================================
console.log("\n10. El guard restringe, no amplía")
// ===========================================================================

{
  // Por diseño el hook solo escribe cuando la decisión es más restrictiva o
  // cuando el permiso venía en "ask". El motor informa de ambos valores para que
  // el módulo pueda aplicar esa regla.
  const c = cfg({ a: [{ action: "*", effect: "allow" }] })
  const d = decide(c, { agent: "a", action: "write", resources: ["/proy/x"], incoming: "allow" }, PATHS)
  check("expone el efecto de entrada", d.incoming === "allow" && d.effect === "allow")
}

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} pasan, ${failed} fallan`)
process.exit(failed === 0 ? 0 : 1)
