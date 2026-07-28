const SAFE_BUNDLED_SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/

export function retirementCandidates(
  activeSkillNames: readonly string[],
  retiredSkills: readonly string[],
): string[] {
  const activeNames = new Set(activeSkillNames)
  return [
    ...new Set(
      retiredSkills.filter(
        (name) =>
          SAFE_BUNDLED_SKILL_NAME.test(name) && !activeNames.has(name),
      ),
    ),
  ]
}
