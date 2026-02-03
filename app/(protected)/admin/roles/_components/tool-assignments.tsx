"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table"
import { useToast } from "@/components/ui/use-toast"

interface Role {
  id: number;
  name: string;
  description: string | null;
  isSystem: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface Tool {
  id: number;
  identifier: string;
  name: string;
  description: string | null;
  promptChainToolId: number | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface ToolAssignmentsProps {
  role: Role
  allTools: Tool[]
  assignedTools: Tool[]
}

export function ToolAssignments({
  role,
  allTools,
  assignedTools: initialAssignedTools
}: ToolAssignmentsProps) {
  const { toast } = useToast()
  const [assignedTools, setAssignedTools] = useState<Tool[]>(initialAssignedTools)
  const [loading, setLoading] = useState(true)
  
  // Fetch assigned tools on mount
  useEffect(() => {
    const abortController = new AbortController()
    
    const fetchAssignedTools = async () => {
      try {
        const response = await fetch(`/api/admin/roles/${role.id}/tools`, {
          signal: abortController.signal
        })
        if (!response.ok) {
          throw new Error('Failed to fetch assigned tools')
        }
        const data = await response.json()
        setAssignedTools(data.tools || [])
      } catch (error) {
        // Don't show toast if the request was aborted
        if (error instanceof Error && error.name === 'AbortError') {
          return
        }
        toast({
          title: "Error",
          description: "Failed to load assigned tools",
          variant: "destructive"
        })
      } finally {
        setLoading(false)
      }
    }
    
    fetchAssignedTools()
    
    return () => {
      abortController.abort()
    }
  }, [role.id, toast])
  
  const handleToggleAssignment = async (tool: Tool) => {
    const isAssigned = assignedTools.some((t) => t.id === tool.id)
    
    try {
      const url = `/api/admin/roles/${role.id}/tools/${tool.id}`
      const response = await fetch(url, {
        method: isAssigned ? 'DELETE' : 'POST',
        headers: {
          'Content-Type': 'application/json',
        }
      })
      
      if (!response.ok) {
        throw new Error(isAssigned ? 'Failed to remove tool' : 'Failed to assign tool')
      }
      
      const data = await response.json()
      if (data.success) {
        if (isAssigned) {
          setAssignedTools(prev => prev.filter(t => t.id !== tool.id))
          toast({
            title: "Success",
            description: `Removed ${tool.name} from ${role.name}`,
            variant: "default"
          })
        } else {
          setAssignedTools(prev => [...prev, tool])
          toast({
            title: "Success",
            description: `Assigned ${tool.name} to ${role.name}`,
            variant: "default"
          })
        }
      }
    } catch {
      toast({
        title: "Error",
        description: isAssigned 
          ? "Failed to remove tool from role"
          : "Failed to assign tool to role",
        variant: "destructive"
      })
    }
  }

  if (loading) {
    return <div>Loading tools...</div>
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-xl font-semibold">
          Tool Assignments for {role.name}
        </h3>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tool</TableHead>
            <TableHead>Description</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-[100px]">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {allTools.map((tool) => {
            const isAssigned = assignedTools.some((t) => t.id === tool.id)
            return (
              <TableRow key={tool.id}>
                <TableCell>{tool.name}</TableCell>
                <TableCell>{tool.description}</TableCell>
                <TableCell>
                  {tool.isActive ? (
                    <span className="text-green-600">Active</span>
                  ) : (
                    <span className="text-red-600">Inactive</span>
                  )}
                </TableCell>
                <TableCell>
                  <Button
                    variant={isAssigned ? "destructive" : "default"}
                    size="sm"
                    onClick={() => handleToggleAssignment(tool)}
                  >
                    {isAssigned ? "Remove" : "Assign"}
                  </Button>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
} 