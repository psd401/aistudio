import Link from "next/link";
import { ArrowRight, Bot, Users } from "lucide-react";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PageBranding } from "@/components/ui/page-branding";
import { getServerSession } from "@/lib/auth/server-session";
import { resolveUserId } from "@/lib/auth/resolve-user";
import { roomsForUser } from "@/lib/rooms/membership";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "My Rooms | AI Studio",
  description: "Open classroom rooms and launch assigned assistants.",
};

export default async function RoomsPage() {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");
  const userId = await resolveUserId(session);
  const rooms = await roomsForUser(userId);

  return (
    <div className="space-y-6" data-testid="student-rooms-page">
      <div>
        <PageBranding />
        <h1 className="text-2xl font-semibold text-foreground">My Rooms</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Open a room to use the assistants your teacher assigned.
        </p>
      </div>

      {rooms.length === 0 ? (
        <Card data-testid="student-rooms-empty">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Users className="h-10 w-10 text-muted-foreground" />
            <div>
              <p className="font-medium">No active rooms yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Rooms will appear here when a teacher adds you or one of your
                classes.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {rooms.map((room) => (
            <Card key={room.id} data-testid={`student-room-${room.id}`}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Users className="h-5 w-5 text-primary" />
                  {room.name}
                </CardTitle>
                <CardDescription>
                  {room.assistants.length === 1
                    ? "1 assigned assistant"
                    : `${room.assistants.length} assigned assistants`}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button asChild className="w-full">
                  <Link href={`/rooms/${room.id}`}>
                    Open room
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {rooms.length > 0 && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Bot className="h-4 w-4" />
          Assistant availability follows your current room memberships.
        </p>
      )}
    </div>
  );
}
