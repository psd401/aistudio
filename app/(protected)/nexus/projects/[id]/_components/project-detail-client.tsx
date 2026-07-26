"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Loader2, MessageSquarePlus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  addNexusProjectMemberAction,
  connectNexusProjectRepositoryAction,
  createNexusProjectConversationAction,
  disconnectNexusProjectRepositoryAction,
  removeNexusProjectMemberAction,
  updateNexusProjectAction,
} from "@/actions/nexus/projects.actions";

interface ProjectDetail {
  projectId: string;
  name: string;
  instructions: string;
  role: "owner" | "editor" | "viewer";
  projectRepositoryId: number;
  projectRepository: { id: number; name: string; itemCount: number } | null;
  members: Array<{
    userId: number;
    role: "owner" | "editor" | "viewer";
    email: string | null;
    firstName: string | null;
    lastName: string | null;
  }>;
  connectedRepositories: Array<{
    id: number;
    name: string;
    description: string | null;
  }>;
  conversations: Array<{
    id: string;
    title: string | null;
    messageCount: number | null;
  }>;
}

interface RepositoryOption {
  id: number;
  name: string;
}

export function ProjectDetailClient({
  project,
  repositoryOptions,
}: {
  project: ProjectDetail;
  repositoryOptions: RepositoryOption[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState(project.name);
  const [instructions, setInstructions] = useState(project.instructions);
  const [memberEmail, setMemberEmail] = useState("");
  const [memberRole, setMemberRole] = useState<"editor" | "viewer">("viewer");
  const [repositoryId, setRepositoryId] = useState("");
  const canEdit = project.role === "owner" || project.role === "editor";

  function run(
    action: () => Promise<{ isSuccess: boolean; message: string }>,
    successMessage: string
  ) {
    startTransition(async () => {
      const result = await action();
      if (!result.isSuccess) {
        toast.error(result.message);
        return;
      }
      toast.success(successMessage);
      router.refresh();
    });
  }

  function startChat() {
    startTransition(async () => {
      const result = await createNexusProjectConversationAction({
        projectId: project.projectId,
      });
      if (!result.isSuccess) {
        toast.error(result.message);
        return;
      }
      router.push(
        `/nexus?conversationId=${result.data.id}&projectId=${project.projectId}`
      );
    });
  }

  const connectedIds = new Set([
    project.projectRepositoryId,
    ...project.connectedRepositories.map((repository) => repository.id),
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6 md:p-10">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/nexus/projects" className="text-sm text-primary">
            ← All projects
          </Link>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">
            {project.name}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your role: {project.role}
          </p>
        </div>
        <Button onClick={startChat} disabled={isPending}>
          <MessageSquarePlus className="mr-2 h-4 w-4" />
          New project chat
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Project context</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <Input
            aria-label="Project name"
            value={name}
            maxLength={200}
            disabled={!canEdit}
            onChange={(event) => setName(event.target.value)}
          />
          <Textarea
            aria-label="Project instructions"
            value={instructions}
            maxLength={20_000}
            disabled={!canEdit}
            onChange={(event) => setInstructions(event.target.value)}
          />
          {canEdit && (
            <Button
              className="w-fit"
              disabled={isPending || name.trim().length === 0}
              onClick={() =>
                run(
                  () =>
                    updateNexusProjectAction({
                      projectId: project.projectId,
                      name,
                      instructions,
                    }),
                  "Project updated"
                )
              }
            >
              Save context
            </Button>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Repositories</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md border p-3 text-sm">
              <p className="font-medium">
                {project.projectRepository?.name ?? "Project files"}
              </p>
              <p className="text-muted-foreground">
                Private project repository ·{" "}
                {project.projectRepository?.itemCount ?? 0} items
              </p>
            </div>
            {project.connectedRepositories.map((repository) => (
              <div
                key={repository.id}
                className="flex items-start justify-between gap-3 rounded-md border p-3"
              >
                <div>
                  <p className="text-sm font-medium">{repository.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {repository.description}
                  </p>
                </div>
                {canEdit && (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Disconnect ${repository.name}`}
                    disabled={isPending}
                    onClick={() =>
                      run(
                        () =>
                          disconnectNexusProjectRepositoryAction({
                            projectId: project.projectId,
                            repositoryId: repository.id,
                          }),
                        "Repository disconnected"
                      )
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
            {canEdit && (
              <div className="flex gap-2">
                <select
                  aria-label="Repository to connect"
                  className="h-10 flex-1 rounded-md border bg-background px-3 text-sm"
                  value={repositoryId}
                  onChange={(event) => setRepositoryId(event.target.value)}
                >
                  <option value="">Select a repository</option>
                  {repositoryOptions
                    .filter((repository) => !connectedIds.has(repository.id))
                    .map((repository) => (
                      <option key={repository.id} value={repository.id}>
                        {repository.name}
                      </option>
                    ))}
                </select>
                <Button
                  disabled={isPending || !repositoryId}
                  onClick={() =>
                    run(
                      () =>
                        connectNexusProjectRepositoryAction({
                          projectId: project.projectId,
                          repositoryId: Number(repositoryId),
                        }),
                      "Repository connected"
                    )
                  }
                >
                  Connect
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Members</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {project.members.map((member) => (
              <div
                key={member.userId}
                className="flex items-center justify-between gap-3 rounded-md border p-3"
              >
                <div>
                  <p className="text-sm font-medium">
                    {[member.firstName, member.lastName].filter(Boolean).join(" ") ||
                      member.email}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {member.email} · {member.role}
                  </p>
                </div>
                {project.role === "owner" && member.role !== "owner" && (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove ${member.email ?? "member"}`}
                    disabled={isPending}
                    onClick={() =>
                      run(
                        () =>
                          removeNexusProjectMemberAction({
                            projectId: project.projectId,
                            memberUserId: member.userId,
                          }),
                        "Member removed"
                      )
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
            {project.role === "owner" && (
              <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
                <Input
                  aria-label="Member email"
                  type="email"
                  placeholder="colleague@psd401.net"
                  value={memberEmail}
                  onChange={(event) => setMemberEmail(event.target.value)}
                />
                <select
                  aria-label="Member role"
                  className="h-10 rounded-md border bg-background px-3 text-sm"
                  value={memberRole}
                  onChange={(event) =>
                    setMemberRole(event.target.value as "editor" | "viewer")
                  }
                >
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                </select>
                <Button
                  disabled={isPending || !memberEmail}
                  onClick={() =>
                    run(
                      () =>
                        addNexusProjectMemberAction({
                          projectId: project.projectId,
                          email: memberEmail,
                          role: memberRole,
                        }),
                      "Member added"
                    )
                  }
                >
                  Add
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Your project chats</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2">
          {project.conversations.map((conversation) => (
            <Link
              key={conversation.id}
              href={`/nexus?conversationId=${conversation.id}&projectId=${project.projectId}`}
              className="rounded-md border p-3 text-sm hover:border-primary/50"
            >
              {conversation.title ?? "Untitled chat"} ·{" "}
              {conversation.messageCount ?? 0} messages
            </Link>
          ))}
          {project.conversations.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No chats yet. Start one to use the project instructions and
              repositories.
            </p>
          )}
        </CardContent>
      </Card>

      {isPending && (
        <div className="fixed bottom-6 right-6 rounded-full border bg-background p-3 shadow">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      )}
    </div>
  );
}
