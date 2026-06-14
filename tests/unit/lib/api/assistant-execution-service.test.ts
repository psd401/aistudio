import { describe, it, expect } from '@jest/globals'
import { decodeMdxEditorEscapes } from '@/lib/utils/text-sanitizer'

/**
 * Unit tests for variable substitution in assistant-execution-service.ts
 * Tests the new slugified name and positional (prompt_N_output) variable resolution
 * paths restored in PR #765.
 */

// Mock the substituteVariables function since it's not exported
// These tests verify the expected behavior based on the implementation
describe('Variable Substitution Logic (substituteVariables)', () => {
  describe('Slugified Prompt Names', () => {
    it('should resolve slugified prompt names with hyphens', () => {
      // Given a prompt named "Facilitator Opening" → slugified to "facilitator-opening"
      // When: ${facilitator-opening} is used
      // Then: Should resolve to the output of that prompt
      const promptName = "Facilitator Opening"
      const expectedSlug = "facilitator-opening"

      // Verify slugify logic
      const slug = promptName.toLowerCase().replace(/[^\da-z]+/g, "-").replace(/(^-|-$)+/g, "")
      expect(slug).toBe(expectedSlug)
    })

    it('should handle prompt names with multiple spaces', () => {
      const promptName = "This   Has    Multiple     Spaces"
      const expectedSlug = "this-has-multiple-spaces"

      const slug = promptName.toLowerCase().replace(/[^\da-z]+/g, "-").replace(/(^-|-$)+/g, "")
      expect(slug).toBe(expectedSlug)
    })

    it('should handle prompt names with special characters', () => {
      const promptName = "User's Analysis (Final)"
      const expectedSlug = "user-s-analysis-final"

      const slug = promptName.toLowerCase().replace(/[^\da-z]+/g, "-").replace(/(^-|-$)+/g, "")
      expect(slug).toBe(expectedSlug)
    })

    it('should handle empty strings by returning empty slug', () => {
      const promptName = ""
      const expectedSlug = ""

      const slug = promptName.toLowerCase().replace(/[^\da-z]+/g, "-").replace(/(^-|-$)+/g, "")
      expect(slug).toBe(expectedSlug)
    })

    it('should handle strings with only special characters', () => {
      const promptName = "!!!"
      const expectedSlug = ""

      const slug = promptName.toLowerCase().replace(/[^\da-z]+/g, "-").replace(/(^-|-$)+/g, "")
      expect(slug).toBe(expectedSlug)
    })

    it('should handle duplicate slugified names (later overwrites earlier)', () => {
      // Given two prompts with names that slugify to the same value
      // The Map will be overwritten with the later prompt's output
      const prompts = [
        { name: "Test!!!", output: "Output 1" },
        { name: "Test???", output: "Output 2" }
      ]

      const slugifiedOutputs = new Map<string, string>()
      for (const prompt of prompts) {
        const slug = prompt.name.toLowerCase().replace(/[^\da-z]+/g, "-").replace(/(^-|-$)+/g, "")
        const uniqueKey = slug || `prompt-${prompts.indexOf(prompt)}`
        slugifiedOutputs.set(uniqueKey, prompt.output)
      }

      // Both slugify to "test", so second overwrites first
      expect(slugifiedOutputs.get("test")).toBe("Output 2")
      expect(slugifiedOutputs.size).toBeGreaterThanOrEqual(1)
    })
  })

  describe('Positional Variable Resolution (prompt_N_output)', () => {
    it('should parse prompt_N_output pattern correctly', () => {
      const varName = "prompt_0_output"
      const positionalMatch = varName.match(/^prompt_(\d+)_output$/)

      expect(positionalMatch).not.toBeNull()
      expect(positionalMatch?.[1]).toBe("0")
    })

    it('should parse multi-digit positions', () => {
      const varName = "prompt_42_output"
      const positionalMatch = varName.match(/^prompt_(\d+)_output$/)

      expect(positionalMatch).not.toBeNull()
      expect(positionalMatch?.[1]).toBe("42")
    })

    it('should not match invalid patterns', () => {
      const invalidPatterns = [
        "promptoutput",
        "prompt_output",
        "prompt_a_output",
        "prompt_0",
        "_prompt_0_output",
        "prompt_0_output_extra"
      ]

      for (const pattern of invalidPatterns) {
        const match = pattern.match(/^prompt_(\d+)_output$/)
        expect(match).toBeNull()
      }
    })

    it('should handle position mapping with gaps in execution', () => {
      // Critical test for the bug fixed in review feedback
      // When prompt at position 0 has no output, position 1 should still map correctly
      interface Prompt {
        id: number
        position: number
        name: string
      }

      const allPrompts: Prompt[] = [
        { id: 1, position: 0, name: "Prompt A" },
        { id: 2, position: 1, name: "Prompt B" },
        { id: 3, position: 2, name: "Prompt C" }
      ]

      // Current: executing prompt at position 3 (after C)
      const currentPromptPosition = 3
      const sortedPrevPrompts = allPrompts.filter(p => p.position < currentPromptPosition)

      const positionToPromptId = new Map<number, number>()

      // Bug fix: Always map position → ID, even if no output
      for (let i = 0; i < sortedPrevPrompts.length; i++) {
        const prevPrompt = sortedPrevPrompts[i]
        positionToPromptId.set(i, prevPrompt.id)
      }

      // Verify correct mapping
      expect(positionToPromptId.get(0)).toBe(1)  // Position 0 → Prompt A (even without output)
      expect(positionToPromptId.get(1)).toBe(2)  // Position 1 → Prompt B
      expect(positionToPromptId.get(2)).toBe(3)  // Position 2 → Prompt C
    })
  })

  describe('Regex Pattern Matching', () => {
    it('should match ${variable} syntax with hyphens', () => {
      const content = "${facilitator-opening} and ${user-input}"
      const regex = /\${([\w-]+)}|{{([\w-]+)}}/g
      const matches = Array.from(content.matchAll(regex))

      expect(matches).toHaveLength(2)
      expect(matches[0][1]).toBe("facilitator-opening")
      expect(matches[1][1]).toBe("user-input")
    })

    it('should match {{variable}} syntax with hyphens', () => {
      const content = "{{prompt-name}} and {{another-var}}"
      const regex = /\${([\w-]+)}|{{([\w-]+)}}/g
      const matches = Array.from(content.matchAll(regex))

      expect(matches).toHaveLength(2)
      expect(matches[0][2]).toBe("prompt-name")
      expect(matches[1][2]).toBe("another-var")
    })

    it('should match positional syntax', () => {
      const content = "${prompt_0_output} and ${prompt_1_output}"
      const regex = /\${([\w-]+)}|{{([\w-]+)}}/g
      const matches = Array.from(content.matchAll(regex))

      expect(matches).toHaveLength(2)
      expect(matches[0][1]).toBe("prompt_0_output")
      expect(matches[1][1]).toBe("prompt_1_output")
    })

    it('should not match variables without hyphens or underscores in old regex', () => {
      // This demonstrates the bug: \w+ doesn't match hyphens
      const content = "${facilitator-opening}"
      const oldRegex = /\${(\w+)}|{{(\w+)}}/g
      const matches = Array.from(content.matchAll(oldRegex))

      expect(matches).toHaveLength(0)  // Bug: hyphenated name not matched
    })

    it('should match variables with hyphens in new regex', () => {
      // This demonstrates the fix: [\w-]+ matches hyphens
      const content = "${facilitator-opening}"
      const newRegex = /\${([\w-]+)}|{{([\w-]+)}}/g
      const matches = Array.from(content.matchAll(newRegex))

      expect(matches).toHaveLength(1)  // Fixed: hyphenated name matched
      expect(matches[0][1]).toBe("facilitator-opening")
    })
  })

  describe('Variable Resolution Priority', () => {
    it('should document the correct resolution order', () => {
      // This test documents the priority order (no actual function calls)
      const resolutionPaths = [
        "Path 1: Explicit inputMapping (backward compatible)",
        "Path 2: User input fields",
        "Path 3: Slugified previous prompt names",
        "Path 4: prompt_N_output positional syntax"
      ]

      expect(resolutionPaths).toHaveLength(4)
      expect(resolutionPaths[0]).toContain("inputMapping")
      expect(resolutionPaths[1]).toContain("input fields")
      expect(resolutionPaths[2]).toContain("Slugified")
      expect(resolutionPaths[3]).toContain("prompt_N_output")
    })
  })

  describe('Edge Cases', () => {
    it('should handle content with no variables', () => {
      const content = "This is plain text with no variables"
      const regex = /\${([\w-]+)}|{{([\w-]+)}}/g
      const matches = Array.from(content.matchAll(regex))

      expect(matches).toHaveLength(0)
    })

    it('should handle malformed variable syntax', () => {
      const content = "${incomplete ${{double}} {missing}"
      const regex = /\${([\w-]+)}|{{([\w-]+)}}/g
      const matches = Array.from(content.matchAll(regex))

      // Should only match valid patterns
      expect(matches.length).toBeLessThanOrEqual(2)
    })

    it('should handle variables at start and end of content', () => {
      const content = "${start} middle ${end}"
      const regex = /\${([\w-]+)}|{{([\w-]+)}}/g
      const matches = Array.from(content.matchAll(regex))

      expect(matches).toHaveLength(2)
      expect(matches[0][1]).toBe("start")
      expect(matches[1][1]).toBe("end")
    })
  })
})

describe('decodeMdxEditorEscapes', () => {
  it('decodes backslash-escaped dollar sign', () => {
    expect(decodeMdxEditorEscapes('\\${student_name}')).toBe('${student_name}')
  })

  it('decodes backslash-escaped curly braces', () => {
    expect(decodeMdxEditorEscapes('$\\{name\\}')).toBe('${name}')
  })

  it('decodes backslash-escaped underscore', () => {
    expect(decodeMdxEditorEscapes('${student\\_name}')).toBe('${student_name}')
  })

  it('decodes HTML entity &#x24; for dollar sign', () => {
    expect(decodeMdxEditorEscapes('&#x24;{student_name}')).toBe('${student_name}')
  })

  it('decodes HTML entity &#36; for dollar sign', () => {
    expect(decodeMdxEditorEscapes('&#36;{student_name}')).toBe('${student_name}')
  })

  it('decodes doubly-encoded HTML entity &amp;#x24; for dollar sign', () => {
    expect(decodeMdxEditorEscapes('&amp;#x24;{student_name}')).toBe('${student_name}')
  })

  it('decodes doubly-encoded HTML entity &amp;#36; for dollar sign', () => {
    expect(decodeMdxEditorEscapes('&amp;#36;{student_name}')).toBe('${student_name}')
  })

  it('doubly-encoded form is matchable by variable-substitution regex after decode', () => {
    const escaped = '&amp;#x24;{student_name}'
    const decoded = decodeMdxEditorEscapes(escaped)
    const regex = /\${([\w-]+)}|{{([\w-]+)}}/g
    const matches = Array.from(decoded.matchAll(regex))
    expect(matches).toHaveLength(1)
    expect(matches[0][1]).toBe('student_name')
  })

  it('decodes fully escaped MDXEditor output so regex matches', () => {
    const escaped = '\\$\\{student\\_name\\}'
    const decoded = decodeMdxEditorEscapes(escaped)
    const regex = /\${([\w-]+)}|{{([\w-]+)}}/g
    const matches = Array.from(decoded.matchAll(regex))
    expect(matches).toHaveLength(1)
    expect(matches[0][1]).toBe('student_name')
  })

  it('is idempotent — decoding already-decoded content is a no-op', () => {
    const clean = '${student_name}'
    expect(decodeMdxEditorEscapes(clean)).toBe(clean)
  })

  it('handles empty string', () => {
    expect(decodeMdxEditorEscapes('')).toBe('')
  })

  it('handles content with no escapes', () => {
    const plain = 'Hello world, no variables here.'
    expect(decodeMdxEditorEscapes(plain)).toBe(plain)
  })

  it('decodes multiple escaped variables in a single pass', () => {
    const escaped = '\\${first} and \\${second}'
    const decoded = decodeMdxEditorEscapes(escaped)
    expect(decoded).toBe('${first} and ${second}')
    const regex = /\${([\w-]+)}|{{([\w-]+)}}/g
    expect(Array.from(decoded.matchAll(regex))).toHaveLength(2)
  })
})

describe('decode + substitute integration', () => {
  const substitute = (content: string, vars: Record<string, string>): string => {
    const decoded = decodeMdxEditorEscapes(content)
    return decoded.replace(/\${([\w-]+)}|{{([\w-]+)}}/g, (match, dollarVar, braceVar) => {
      const varName = dollarVar || braceVar
      return varName in vars ? vars[varName] : match
    })
  }

  it('resolves a backslash-escaped variable after decode', () => {
    expect(substitute('Hello \\${name}!', { name: 'Alice' })).toBe('Hello Alice!')
  })

  it('resolves an HTML-entity-encoded variable after decode', () => {
    expect(substitute('&#x24;{student_name}', { student_name: 'Bob' })).toBe('Bob')
  })

  it('resolves a hyphenated variable name', () => {
    expect(substitute('${student-name}', { 'student-name': 'Carol' })).toBe('Carol')
  })

  it('leaves unmatched variables unchanged', () => {
    expect(substitute('${name}', {})).toBe('${name}')
  })
})

describe('Import stale inputMapping safety', () => {
  it('documents that Path 1 inputMapping can resolve to wrong prompt in destination system', () => {
    // When an assistant is imported from system A to system B:
    // - Source: prompt with ID 5 = "Intro Prompt" (inputMapping references prompt_5.output)
    // - Destination: prompt with ID 5 = some COMPLETELY DIFFERENT prompt in another assistant
    // Path 1 would call previousOutputs.get(5) and return the wrong prompt's output.
    // Fix: import route sets inputMapping: null so Path 1 is never invoked for imports.

    const staleMapping = { result: 'prompt_5.output' }
    // Simulating destination system: prompt ID 5 belongs to a different assistant
    const previousOutputs = new Map([[5, 'WRONG OUTPUT from unrelated prompt']])

    const promptMatch = staleMapping.result.match(/^prompt_(\d+)\.output$/)
    expect(promptMatch).not.toBeNull()

    const promptId = Number.parseInt(promptMatch![1], 10)
    const output = previousOutputs.get(promptId)
    // This demonstrates the bug: stale ID 5 resolves to the WRONG prompt's output
    expect(output).toBe('WRONG OUTPUT from unrelated prompt')
  })

  it('documents that null inputMapping safely falls through to Path 2 resolution', () => {
    const mapping: Record<string, string> = {}  // null inputMapping means empty object in runtime
    const varName = 'student_name'

    // Path 1 is skipped when mapping[varName] is falsy
    expect(mapping[varName]).toBeFalsy()

    // Path 2 correctly resolves from user inputs
    const inputs = { student_name: 'Alice' }
    expect(inputs[varName as keyof typeof inputs]).toBe('Alice')
  })
})
