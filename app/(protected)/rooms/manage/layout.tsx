import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth/server-session";
import { hasCapabilityAccess } from "@/utils/roles";

export default async function RoomsManageLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getServerSession();
  if (!session) {
    redirect("/sign-in");
  }
  if (!(await hasCapabilityAccess("rooms-manage", session.sub))) {
    redirect("/dashboard");
  }

  return children;
}
