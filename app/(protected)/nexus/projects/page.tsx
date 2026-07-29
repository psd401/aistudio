import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth/server-session";
import { getUserIdByCognitoSubAsNumber } from "@/lib/db/drizzle";
import { listNexusProjects } from "@/lib/nexus/projects/project-service";
import { ProjectsClient } from "./_components/projects-client";

export default async function NexusProjectsPage() {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");
  const userId = await getUserIdByCognitoSubAsNumber(session.sub);
  if (!userId) redirect("/sign-in");
  const projects = await listNexusProjects(userId);
  return (
    <div className="h-full overflow-y-auto">
      <ProjectsClient projects={projects} />
    </div>
  );
}
