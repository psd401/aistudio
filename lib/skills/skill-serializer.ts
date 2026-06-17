/**
 * Assistant Architect → SKILL.md serializer (Issue #925).
 *
 * Pure functions that convert an Assistant Architect (name, description,
 * chained prompts, input fields, enabled tools) into Anthropic's canonical
 * SKILL.md format — the format AI Studio committed to in Epic #922.
 *
 * No I/O here. The server action (`publish-skill.actions.ts`) handles S3
 * upload, DB registration, and the scan-pipeline invoke. Keeping serialization
 * pure makes it unit-testable and reusable for the future zip-export flow.
 *
 * Frontmatter contract (matches infra/agent-image/skills/{name}/SKILL.md and
 * the parser in agent-platform-stack.ts):
 *   name          — slug (alphanumeric, hyphens, underscores, dots)
 *   summary       — one-line catalog summary (required by the scanner)
 *   description    — longer description
 *   allowed-tools — derived from the assistant's enabled tools
 */

/** Minimal shape the serializer needs from an assistant's input field. */
export interface SerializerInputField {
  name: string
  label: string | null
  fieldType: string
  options?: unknown
}

/** Minimal shape the serializer needs from an assistant's chained prompt. */
export interface SerializerPrompt {
  name: string
  content: string
  systemContext?: string | null
  position?: number | null
  enabledTools?: string[] | null
}

/** Minimal shape the serializer needs from the assistant itself. */
export interface SerializerAssistant {
  name: string
  description: string | null
  inputFields?: SerializerInputField[]
  prompts?: SerializerPrompt[]
}

/** Result of serialization. */
export interface SerializedSkill {
  /** URL/S3-safe slug used as the skill `name` and folder. */
  slug: string
  /** Full SKILL.md text (frontmatter + body). */
  skillMd: string
  /** One-line summary placed in frontmatter and the agent_skills row. */
  summary: string
  /** Tool identifiers derived from the assistant, deduped and sorted. */
  allowedTools: string[]
}

const SLUG_MAX_LENGTH = 64
const SUMMARY_MAX_LENGTH = 200

/**
 * Convert an arbitrary assistant name into a SKILL.md-safe slug.
 * Lowercase, alphanumeric + hyphens only, collapsed and trimmed.
 * The scanner's SAFE_NAME_RE allows [a-zA-Z0-9_.-]; we deliberately produce a
 * stricter, lowercase, hyphen-only slug for predictable, collision-resistant
 * folder names.
 */
export function slugifySkillName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    // Strip accents/diacritics
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, "")

  return slug
}

/**
 * Escape a value for safe inclusion on a single YAML frontmatter line.
 * Strips newlines (frontmatter values are single-line) and trims. If the value
 * contains characters that would break unquoted YAML (`:` followed by space,
 * leading special chars), it is wrapped in double quotes with internal quotes
 * escaped.
 */
function toYamlScalar(value: string): string {
  const oneLine = value.replace(/\s*\n\s*/g, " ").trim()
  const needsQuoting =
    oneLine === "" ||
    /^[\s>|!&*#?@`%"'\-\[\]{},]/.test(oneLine) ||
    /:\s/.test(oneLine) ||
    /\s#/.test(oneLine) ||
    oneLine.endsWith(":")

  if (!needsQuoting) {
    return oneLine
  }
  return `"${oneLine.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

/**
 * Derive the `allowed-tools` list from an assistant's prompts. Each prompt
 * declares its tools in `enabledTools` (a JSONB string[]). We take the union,
 * dedupe, and sort for deterministic output.
 *
 * Returns catalog tool identifiers as-is. AI-Studio-specific tools (e.g.
 * `nexus.chat`) are passed through unchanged — the export documentation notes
 * which references are platform-specific.
 */
export function deriveAllowedTools(prompts: SerializerPrompt[] = []): string[] {
  const set = new Set<string>()
  for (const prompt of prompts) {
    const tools = Array.isArray(prompt.enabledTools) ? prompt.enabledTools : []
    for (const tool of tools) {
      const trimmed = typeof tool === "string" ? tool.trim() : ""
      if (trimmed) set.add(trimmed)
    }
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b))
}

/**
 * Build a one-line summary from the assistant's description, truncated to the
 * scanner/catalog limit. Falls back to a generic line when no description.
 */
export function buildSummary(assistant: SerializerAssistant): string {
  const raw = (assistant.description ?? "").replace(/\s*\n\s*/g, " ").trim()
  const base =
    raw.length > 0
      ? raw
      : `Published from the "${assistant.name}" assistant in AI Studio.`
  if (base.length <= SUMMARY_MAX_LENGTH) return base
  // Truncate on a word boundary where possible, leaving room for the ellipsis.
  const truncated = base.slice(0, SUMMARY_MAX_LENGTH - 1)
  const lastSpace = truncated.lastIndexOf(" ")
  const cut = lastSpace > SUMMARY_MAX_LENGTH * 0.6 ? truncated.slice(0, lastSpace) : truncated
  return `${cut.trimEnd()}…`
}

/** Render the markdown body documenting input fields. */
function renderInputFields(fields: SerializerInputField[]): string {
  if (fields.length === 0) {
    return "_This assistant takes no structured inputs._"
  }
  const lines = ["| Field | Label | Type |", "| --- | --- | --- |"]
  for (const f of fields) {
    const label = (f.label ?? "").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").trim() || "—"
    const name = f.name.replace(/\\/g, "\\\\").replace(/\|/g, "\\|")
    const type = f.fieldType.replace(/\\/g, "\\\\").replace(/\|/g, "\\|")
    lines.push(`| \`${name}\` | ${label} | ${type} |`)
  }
  return lines.join("\n")
}

/** Render the markdown body documenting the prompt chain. */
function renderPrompts(prompts: SerializerPrompt[]): string {
  if (prompts.length === 0) {
    return "_No prompts defined._"
  }
  const ordered = [...prompts].sort(
    (a, b) => (a.position ?? 0) - (b.position ?? 0)
  )
  const sections: string[] = []
  for (const [idx, p] of ordered.entries()) {
    const heading = `### Step ${idx + 1}: ${p.name || `Prompt ${idx + 1}`}`
    const parts = [heading]
    if (p.systemContext && p.systemContext.trim()) {
      parts.push(`**System context**\n\n${p.systemContext.trim()}`)
    }
    parts.push(`**Prompt**\n\n${(p.content ?? "").trim()}`)
    const tools = Array.isArray(p.enabledTools) ? p.enabledTools.filter(Boolean) : []
    if (tools.length > 0) {
      parts.push(`**Tools:** ${tools.join(", ")}`)
    }
    sections.push(parts.join("\n\n"))
  }
  return sections.join("\n\n")
}

/**
 * Serialize an assistant into a complete SKILL.md document plus metadata.
 *
 * @throws Error if the assistant name cannot produce a valid slug.
 */
export function serializeAssistantToSkill(
  assistant: SerializerAssistant
): SerializedSkill {
  const slug = slugifySkillName(assistant.name)
  if (!slug) {
    throw new Error(
      `Assistant name "${assistant.name}" does not produce a valid skill slug. ` +
        "Provide a name with at least one alphanumeric character."
    )
  }

  const summary = buildSummary(assistant)
  const allowedTools = deriveAllowedTools(assistant.prompts ?? [])
  const inputFields = assistant.inputFields ?? []
  const prompts = assistant.prompts ?? []

  const frontmatterLines = [
    "---",
    `name: ${toYamlScalar(slug)}`,
    `summary: ${toYamlScalar(summary)}`,
  ]
  if (assistant.description && assistant.description.trim()) {
    frontmatterLines.push(
      `description: ${toYamlScalar(assistant.description)}`
    )
  }
  // allowed-tools uses a comma-separated inline list when present. Omitting the
  // key entirely (rather than an empty value) keeps the assistant open to all
  // catalog tools the caller already has, matching infra skills that pin tools
  // only when needed.
  if (allowedTools.length > 0) {
    frontmatterLines.push(`allowed-tools: ${allowedTools.join(", ")}`)
  }
  frontmatterLines.push("---")

  const body = [
    `# ${assistant.name}`,
    assistant.description?.trim()
      ? assistant.description.trim()
      : "Published from an AI Studio Assistant Architect.",
    "## Inputs",
    renderInputFields(inputFields),
    "## Instructions",
    renderPrompts(prompts),
    "---",
    "_Published from AI Studio Assistant Architect. Some tool references " +
      "(e.g. `nexus.chat`) are AI-Studio-specific and may need replacement " +
      "when run outside the platform._",
  ].join("\n\n")

  const skillMd = `${frontmatterLines.join("\n")}\n\n${body}\n`

  return { slug, skillMd, summary, allowedTools }
}
