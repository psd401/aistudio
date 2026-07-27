import { redirect } from "next/navigation";
import { NavbarNested } from "@/components/navigation/navbar-nested";
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

  return (
    <div className="flex min-h-screen">
      <NavbarNested fullHeight />
      <main className="min-w-0 flex-1 bg-white lg:pl-[68px]">
        <div className="mx-auto max-w-7xl p-4 sm:p-6 md:p-8">
          {children}
        </div>
      </main>
    </div>
  );
}
