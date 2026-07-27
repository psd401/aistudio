import { notFound, redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth/server-session";
import { getUserIdByCognitoSubAsNumber } from "@/lib/db/drizzle";
import { listRepositoryCatalog } from "@/lib/repositories/repository-catalog-service";
import {
  getNexusProject,
  NexusProjectAccessError,
} from "@/lib/nexus/projects/project-service";
import { ProjectDetailClient } from "./_components/project-detail-client";

export default async function NexusProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");
  const userId = await getUserIdByCognitoSubAsNumber(session.sub);
  if (!userId) redirect("/sign-in");
  const { id } = await params;
  const [project, repositoryOptions] = await Promise.all([
      getNexusProject(id, userId),
      listRepositoryCatalog(session.sub),
    ]).catch((error: unknown) => {
    if (error instanceof NexusProjectAccessError) notFound();
    throw error;
  });
  return (
    <div className="h-full overflow-y-auto">
      <ProjectDetailClient
        project={project}
        repositoryOptions={repositoryOptions}
      />
    </div>
  );
}
