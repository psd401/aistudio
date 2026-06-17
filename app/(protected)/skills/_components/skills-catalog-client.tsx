"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { Search, Wrench } from "lucide-react"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { CatalogSkill } from "@/actions/db/skills-catalog.actions"

interface SkillsCatalogClientProps {
  initialSkills: CatalogSkill[]
}

/**
 * Client grid for the skill catalog (Issue #925, AC#4). Filters the approved
 * skills client-side by name/summary and links each to its detail page.
 */
export function SkillsCatalogClient({ initialSkills }: SkillsCatalogClientProps) {
  const [query, setQuery] = useState("")

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return initialSkills
    return initialSkills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.summary.toLowerCase().includes(q)
    )
  }, [initialSkills, query])

  if (initialSkills.length === 0) {
    return (
      <Card data-testid="skills-empty-state">
        <CardContent className="py-10 text-center text-muted-foreground">
          No approved skills yet. Publish an assistant as a skill from the
          Assistant Architect, then an administrator can approve it here.
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <Input
        icon={<Search className="h-4 w-4" />}
        placeholder="Search skills…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search skills"
        data-testid="skills-search"
      />

      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center">
          No skills match “{query}”.
        </p>
      ) : (
        <div
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"
          data-testid="skills-grid"
        >
          {filtered.map((skill) => (
            <Card
              key={skill.id}
              className="flex flex-col"
              data-testid="skill-card"
            >
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Wrench className="h-4 w-4 text-muted-foreground" />
                  {skill.name}
                </CardTitle>
                <CardDescription className="line-clamp-3">
                  {skill.summary}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">v{skill.version}</Badge>
                  {skill.allowedTools.length > 0 && (
                    <Badge variant="outline">
                      {skill.allowedTools.length} pinned tool
                      {skill.allowedTools.length === 1 ? "" : "s"}
                    </Badge>
                  )}
                </div>
              </CardContent>
              <CardFooter>
                <Button asChild variant="outline" className="w-full">
                  <Link href={`/skills/${skill.id}`}>View skill</Link>
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
