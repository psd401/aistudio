"use client"

import { useState, useEffect, useCallback } from "react"
import { useToast } from "@/components/ui/use-toast"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { PageBranding } from "@/components/ui/page-branding"
import { IconRefresh, IconTrash } from "@tabler/icons-react"
import {
  getAgentSkills,
  deleteSkill,
  type SkillRow,
} from "@/actions/admin/agent-skills.actions"

const SCOPE_OPTIONS = [
  { value: "all", label: "All Scopes" },
  { value: "shared", label: "Shared" },
  { value: "user", label: "User" },
  { value: "draft", label: "Draft" },
  { value: "rejected", label: "Rejected" },
]

function scopeBadgeVariant(scope: string) {
  switch (scope) {
    case "shared":
      return "default" as const
    case "user":
      return "secondary" as const
    case "draft":
      return "outline" as const
    case "rejected":
      return "destructive" as const
    default:
      return "outline" as const
  }
}

function scanBadgeVariant(status: string) {
  switch (status) {
    case "clean":
      return "default" as const
    case "flagged":
      return "destructive" as const
    case "pending":
      return "outline" as const
    default:
      return "outline" as const
  }
}

export function SkillsListClient() {
  const { toast } = useToast()
  const [skills, setSkills] = useState<SkillRow[]>([])
  const [total, setTotal] = useState(0)
  const [scopeFilter, setScopeFilter] = useState("all")
  const [loading, setLoading] = useState(true)

  const loadSkills = useCallback(async () => {
    setLoading(true)
    try {
      const scope = scopeFilter === "all" ? undefined : scopeFilter
      const result = await getAgentSkills(scope)
      if (result.isSuccess && result.data) {
        setSkills(result.data.skills)
        setTotal(result.data.total)
      } else {
        toast({
          title: "Error",
          description: result.message || "Failed to load skills",
          variant: "destructive",
        })
      }
    } finally {
      setLoading(false)
    }
  }, [scopeFilter, toast])

  useEffect(() => {
    loadSkills()
  }, [loadSkills])

  const handleDelete = async (skillId: string) => {
    const result = await deleteSkill(skillId, 0) // adminUserId resolved server-side
    if (result.isSuccess) {
      toast({ title: "Skill deleted" })
      loadSkills()
    } else {
      toast({
        title: "Error",
        description: result.message || "Failed to delete",
        variant: "destructive",
      })
    }
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <PageBranding />
        <h1 className="text-2xl font-bold">Agent Skills</h1>
        <p className="text-muted-foreground text-sm">Manage agent skills across all scopes</p>
      </div>

      <div className="flex items-center gap-4">
        <Select value={scopeFilter} onValueChange={setScopeFilter}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Filter by scope" />
          </SelectTrigger>
          <SelectContent>
            {SCOPE_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button variant="outline" size="sm" onClick={loadSkills} disabled={loading}>
          <IconRefresh className="h-4 w-4 mr-1" />
          Refresh
        </Button>

        <span className="text-sm text-muted-foreground">
          {total} skill{total !== 1 ? "s" : ""}
        </span>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead>Scan</TableHead>
              <TableHead>Summary</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-[80px]">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {skills.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground">
                  {loading ? "Loading..." : "No skills found"}
                </TableCell>
              </TableRow>
            ) : (
              skills.map((skill) => (
                <TableRow key={skill.id}>
                  <TableCell className="font-medium">{skill.name}</TableCell>
                  <TableCell>
                    <Badge variant={scopeBadgeVariant(skill.scope)}>
                      {skill.scope}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={scanBadgeVariant(skill.scanStatus)}>
                      {skill.scanStatus}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-[300px] truncate">
                    {skill.summary}
                  </TableCell>
                  <TableCell>v{skill.version}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {new Date(skill.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDelete(skill.id)}
                      title="Delete skill"
                    >
                      <IconTrash className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
