import Link from "next/link"
import { requireRole } from "@/lib/auth/role-helpers"
import { PageBranding } from "@/components/ui/page-branding"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { getTriageSummaryList } from "@/actions/admin/agent-triage.actions"
import { getSkillReviewQueue } from "@/actions/admin/agent-skills.actions"
import { getModerationStats } from "@/actions/admin/moderate-prompt.actions"
import { listPendingApprovalsAction } from "@/actions/db/atrium/approvals"
import { ADMIN_SECTIONS } from "./_lib/admin-pages"
import { TriageQuickJump } from "./_components/triage-quick-jump"

export const metadata = { title: "Admin", description: "All administration pages in one place" }

/**
 * Admin hub — the single landing page for all administration surfaces.
 *
 * Cards are driven by the ADMIN_SECTIONS registry (./_lib/admin-pages.ts); the
 * sidebar carries only one "Admin" entry pointing here (migration 131), so new
 * admin pages need a registry entry, not a navigation_items row.
 */
export default async function AdminHubPage() {
  await requireRole("administrator")

  // Triage state lives in DynamoDB; unavailable locally. Every action here
  // returns a failed ActionState rather than throwing, so the hub degrades
  // (no badge / empty quick-jump message) instead of erroring.
  const [triageResult, approvalsResult, skillQueueResult, moderationResult] =
    await Promise.all([
      getTriageSummaryList(),
      listPendingApprovalsAction(),
      getSkillReviewQueue(),
      getModerationStats(),
    ])
  const triageUsers = triageResult.isSuccess
    ? (triageResult.data ?? []).map(row => ({
        email: row.userEmail,
        enabled: row.enabled,
      }))
    : []

  // Pending-work counts shown as "N pending" badges on the matching cards.
  const badges: Record<string, number> = Object.create(null)
  if (approvalsResult.isSuccess) {
    badges["atrium"] = (approvalsResult.data ?? []).length
  }
  if (skillQueueResult.isSuccess) {
    badges["skills-review"] = (skillQueueResult.data ?? []).length
  }
  if (moderationResult.isSuccess) {
    badges["prompts"] = moderationResult.data?.pending ?? 0
  }

  return (
    <div className="p-6" data-testid="admin-hub">
      <div className="mb-8">
        <PageBranding />
        <h1 className="text-2xl font-semibold text-foreground">Admin</h1>
        <p className="text-sm text-muted-foreground mt-1">
          All administration pages in one place
        </p>
      </div>

      <div className="space-y-8">
        {ADMIN_SECTIONS.map(section => (
          <section key={section.label}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className={cn("text-sm font-semibold uppercase tracking-wide", section.colors.text)}>
                {section.label}
              </h2>
              {section.label === "Agent Platform" && (
                <TriageQuickJump users={triageUsers} />
              )}
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {section.pages.map(page => {
                const Icon = page.icon
                const pending = badges[page.slug] ?? 0
                return (
                  <Link
                    key={page.href}
                    href={page.href}
                    data-testid={`admin-card-${page.slug}`}
                    className="group focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl"
                  >
                    <Card className="h-full transition-all duration-200 group-hover:shadow-lg group-hover:-translate-y-0.5">
                      <CardHeader className="pb-2">
                        <div className="flex items-center gap-3">
                          <div
                            className={cn(
                              "flex h-11 w-11 items-center justify-center rounded-xl flex-shrink-0",
                              section.colors.bg
                            )}
                          >
                            <Icon
                              className="h-5 w-5"
                              style={{ color: section.colors.icon }}
                              aria-hidden="true"
                            />
                          </div>
                          <h3 className="flex-1 font-semibold text-base">{page.title}</h3>
                          {pending > 0 && (
                            <Badge
                              variant="secondary"
                              className="bg-amber-100 text-amber-800 hover:bg-amber-100"
                              data-testid={`admin-card-badge-${page.slug}`}
                            >
                              {pending} pending
                            </Badge>
                          )}
                        </div>
                      </CardHeader>
                      <CardContent>
                        <p className="text-sm text-muted-foreground line-clamp-2">
                          {page.description}
                        </p>
                      </CardContent>
                    </Card>
                  </Link>
                )
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
