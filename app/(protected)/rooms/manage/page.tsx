import { getRoomsManageDataAction } from "@/actions/db/rooms-actions";
import { PageBranding } from "@/components/ui/page-branding";
import { RoomsManageClient } from "./_components/rooms-manage-client";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Manage Rooms | AI Studio",
  description: "Compose roster sections and assistants into student rooms.",
};

export default async function RoomsManagePage() {
  const result = await getRoomsManageDataAction();

  return (
    <div className="space-y-6" data-testid="rooms-manage-page">
      <div>
        <PageBranding />
        <h1 className="text-2xl font-semibold text-foreground">Manage Rooms</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Build rooms from your ClassLink sections, add individual students, and
          assign assistants you can access.
        </p>
      </div>

      {result.isSuccess && result.data ? (
        <RoomsManageClient initialData={result.data} />
      ) : (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive"
          role="alert"
        >
          {result.message ?? "Failed to load room management."}
        </div>
      )}
    </div>
  );
}
