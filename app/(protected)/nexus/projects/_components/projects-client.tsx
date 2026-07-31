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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { meridianPortalClassName } from "@/lib/meridian/fonts";
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
  // The create form used to sit permanently at the top of the page, pushing the
  // project list below the fold and giving "New project" nothing to do. It is a
  // modal now, matching every other create flow in the app.
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  function createProject() {
    startTransition(async () => {
      const result = await createNexusProjectAction({ name, instructions });
      if (!result.isSuccess) {
        toast.error(result.message);
        return;
      }
      setName("");
      setInstructions("");
      setIsCreateOpen(false);
      router.push(`/nexus/projects/${result.data.id}`);
    });
  }

  return (
    <div className="mx-auto max-w-6xl space-y-8 p-6 md:p-10">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Nexus Projects</h1>
          <p className="mt-2 text-muted-foreground">
            Durable project instructions, shared repositories, members, and chats.
          </p>
        </div>
        <Button onClick={() => setIsCreateOpen(true)} className="shrink-0">
          <Plus className="mr-2 h-4 w-4" />
          New project
        </Button>
      </div>

      <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <DialogContent className={meridianPortalClassName}>
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              Instructions here apply to every chat in the project.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
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
              rows={5}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={isPending || name.trim().length === 0}
              onClick={createProject}
            >
              {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
