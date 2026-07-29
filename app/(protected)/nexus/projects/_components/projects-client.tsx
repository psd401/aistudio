"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { FolderKanban, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createNexusProjectAction } from "@/actions/nexus/projects.actions";

interface ProjectListItem {
  id: string;
  name: string;
  instructions: string;
  role: "owner" | "editor" | "viewer";
  conversationCount: number;
  updatedAt: Date;
}

export function ProjectsClient({ projects }: { projects: ProjectListItem[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");

  function createProject() {
    startTransition(async () => {
      const result = await createNexusProjectAction({ name, instructions });
      if (!result.isSuccess) {
        toast.error(result.message);
        return;
      }
      setName("");
      setInstructions("");
      router.push(`/nexus/projects/${result.data.id}`);
    });
  }

  return (
    <div className="mx-auto max-w-6xl space-y-8 p-6 md:p-10">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Nexus Projects</h1>
        <p className="mt-2 text-muted-foreground">
          Durable project instructions, shared repositories, members, and chats.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Plus className="h-5 w-5" />
            New project
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Input
            aria-label="Project name"
            placeholder="Project name"
            maxLength={200}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Textarea
            aria-label="Project instructions"
            placeholder="Instructions Nexus should apply to every project chat"
            maxLength={20_000}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
          />
          <Button
            className="w-fit"
            disabled={isPending || name.trim().length === 0}
            onClick={createProject}
          >
            {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create project
          </Button>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {projects.map((project) => (
          <Link key={project.id} href={`/nexus/projects/${project.id}`}>
            <Card className="h-full transition-colors hover:border-primary/50">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <FolderKanban className="h-5 w-5 text-primary" />
                  {project.name}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-muted-foreground">
                <p className="line-clamp-2">
                  {project.instructions || "No project instructions yet."}
                </p>
                <p>
                  {project.role} · {project.conversationCount} chat
                  {project.conversationCount === 1 ? "" : "s"}
                </p>
              </CardContent>
            </Card>
          </Link>
        ))}
        {projects.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Create your first project to establish a durable Nexus workspace.
          </p>
        )}
      </div>
    </div>
  );
}
