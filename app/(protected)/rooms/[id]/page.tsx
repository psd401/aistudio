import Link from "next/link";
import { ArrowLeft, ArrowRight, Bot } from "lucide-react";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
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
import { roomForUser } from "@/lib/rooms/membership";

export const dynamic = "force-dynamic";

interface StudentRoomPageProps {
  params: Promise<{ id: string }>;
}

export default async function StudentRoomPage({
  params,
}: StudentRoomPageProps) {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");
  const { id } = await params;
  const parsedId = z.string().uuid().safeParse(id);
  if (!parsedId.success) notFound();

  const userId = await resolveUserId(session);
  const room = await roomForUser(userId, parsedId.data);
  if (!room) notFound();

  return (
    <div className="space-y-6" data-testid="student-room-detail">
      <div>
        <PageBranding />
        <Button variant="ghost" size="sm" asChild className="-ml-3 mb-2">
          <Link href="/rooms">
            <ArrowLeft className="mr-2 h-4 w-4" />
            My Rooms
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold text-foreground">{room.name}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Launch an assistant assigned to this room.
        </p>
      </div>

      {room.assistants.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Bot className="h-10 w-10 text-muted-foreground" />
            <div>
              <p className="font-medium">No assistants assigned yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Check back after your teacher assigns an assistant.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {room.assistants.map((assistant) => (
            <Card
              key={assistant.id}
              data-testid={`room-assistant-${assistant.id}`}
            >
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Bot className="h-5 w-5 text-primary" />
                  {assistant.name}
                </CardTitle>
                <CardDescription>
                  {assistant.description ?? "AI Studio assistant"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button asChild className="w-full">
                  <Link href={`/tools/assistant-architect/${assistant.id}`}>
                    Launch assistant
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
