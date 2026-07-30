export interface BundledSkillFrontmatter {
  name: string;
  summary: string;
  description: string;
  allowedTools: string[];
}

/**
 * Parse the small SKILL.md frontmatter subset needed by the bundled-skill
 * initializer. This deliberately avoids a YAML runtime dependency in CDK while
 * accepting both supported `allowed-tools` forms:
 *
 *   allowed-tools: Read, documents.create@v1
 *
 * and:
 *
 *   allowed-tools:
 *     - Read
 *     - documents.create@v1
 */
export function parseBundledSkillFrontmatter(
  raw: string,
): BundledSkillFrontmatter | null {
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) {
    return null;
  }

  let name = '';
  let summary = '';
  let description = '';
  const allowedTools: string[] = [];
  let inAllowedToolsBlock = false;

  for (const rawLine of frontmatter[1].split(/\r?\n/)) {
    const allowedToolsField = rawLine.match(/^allowed-tools:\s*(.*)$/);
    if (allowedToolsField) {
      const inline = allowedToolsField[1].trim();
      if (inline) {
        allowedTools.push(
          ...inline
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean),
        );
      }
      inAllowedToolsBlock = inline.length === 0;
      continue;
    }

    if (inAllowedToolsBlock) {
      const listItem = rawLine.match(/^\s+-\s+(.+?)\s*$/);
      if (listItem) {
        allowedTools.push(listItem[1].trim());
        continue;
      }
      if (rawLine.trim() === '') {
        continue;
      }
      inAllowedToolsBlock = false;
    }

    const field = rawLine.match(/^(name|summary|description):\s*(.*)$/);
    if (!field) {
      continue;
    }
    if (field[1] === 'name') {
      name = field[2].trim();
    } else if (field[1] === 'summary') {
      summary = field[2].trim();
    } else {
      description = field[2].trim();
    }
  }

  if (!name) {
    return null;
  }

  return {
    name,
    summary: summary || `Bundled skill: ${name}`,
    description,
    allowedTools,
  };
}
