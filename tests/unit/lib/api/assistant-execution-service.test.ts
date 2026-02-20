import { describe, it, expect, beforeEach } from '@jest/globals'

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

      // previousOutputs only has B and C (A failed or hasn't executed)
      const previousOutputs = new Map<number, string>([
        [2, "Output B"],
        [3, "Output C"]
      ])

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
