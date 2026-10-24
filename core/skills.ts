/**
 * Skills que viajan con el paquete (`skills/<id>/SKILL.md`) y se registran en cada
 * directorio donde carga apex, sin copiar nada a `~/.config/opencode/skills`.
 *
 * Mismo contrato que las skills de fichero de OpenCode: id = nombre de la carpeta,
 * `name`/`description` del frontmatter, contenido = el cuerpo sin frontmatter.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import type { Scope } from "effect"
import type { Plugin } from "@opencode/plugin/effect"

const SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url))

export interface PackagedSkill {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly path: string
  readonly content: string
}

/** Frontmatter YAML plano (`clave: valor` por línea) + cuerpo. */
export function parseSkillFile(id: string, path: string, text: string): PackagedSkill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  const fields: Record<string, string> = {}
  if (match) {
    for (const line of match[1]!.split(/\r?\n/)) {
      const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
      if (pair) fields[pair[1]!] = pair[2]!.trim().replace(/^(["'])(.*)\1$/, "$2")
    }
  }
  return {
    id,
    name: fields.name || id,
    ...(fields.description ? { description: fields.description } : {}),
    path,
    content: match ? text.slice(match[0].length) : text,
  }
}

export function loadPackagedSkills(dir: string = SKILLS_DIR): PackagedSkill[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "SKILL.md")))
    .map((entry) => {
      const path = join(dir, entry.name, "SKILL.md")
      return parseSkillFile(entry.name, path, readFileSync(path, "utf8"))
    })
}

export function registerSkills(ctx: Plugin.Context): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const skills = loadPackagedSkills()
    if (skills.length === 0) return
    yield* ctx.skill.transform((editor) => {
      for (const skill of skills) editor.add(skill as never)
    })
  })
}
