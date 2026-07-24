import type { LucideIcon } from "lucide-react"
import {
  Activity,
  BookOpenCheck,
  Bot,
  ClipboardList,
  Compass,
  Cpu,
  Flag,
  Gauge,
  GitBranch,
  KeyRound,
  Library,
  Plug,
  Settings,
  ShieldCheck,
  Users,
  UsersRound,
  Wrench,
} from "lucide-react"

/**
 * Single source of truth for every admin page: route, title, description, and
 * icon. The /admin hub renders its cards from this list, so a new admin page
 * only needs an entry here to appear — no navigation_items row required
 * (migration 131 retired the per-page sidebar rows).
 */
export interface AdminPageEntry {
  href: string
  title: string
  description: string
  icon: LucideIcon
  /** Stable slug for data-testid hooks (admin-card-<slug>) */
  slug: string
}

export interface AdminSection {
  label: string
  /** Tailwind classes + hex for the icon tile, mirroring the assistant catalog cards */
  colors: { bg: string; text: string; icon: string }
  pages: AdminPageEntry[]
}

export const ADMIN_SECTIONS: AdminSection[] = [
  {
    label: "Access & Security",
    colors: { bg: "bg-[#7B68A6]/15", text: "text-[#7B68A6]", icon: "#7B68A6" },
    pages: [
      {
        href: "/admin/users",
        title: "User Management",
        description: "Manage users, roles, and permissions",
        icon: Users,
        slug: "users",
      },
      {
        href: "/admin/roles",
        title: "Roles & Capabilities",
        description:
          "Configure roles, their capability permissions, and the capability registry",
        icon: ShieldCheck,
        slug: "roles",
      },
      {
        href: "/admin/groups",
        title: "Groups",
        description:
          "Google Directory group sync — selection rules, membership, and manual sync",
        icon: UsersRound,
        slug: "groups",
      },
      {
        href: "/admin/oauth-clients",
        title: "OAuth Clients",
        description:
          "Manage OAuth2/OIDC client applications for external service authentication",
        icon: KeyRound,
        slug: "oauth-clients",
      },
    ],
  },
  {
    label: "AI & Content",
    colors: { bg: "bg-[#6B9E78]/15", text: "text-[#6B9E78]", icon: "#6B9E78" },
    pages: [
      {
        href: "/admin/models",
        title: "AI Models",
        description: "Manage the AI model catalog, providers, and capabilities",
        icon: Cpu,
        slug: "models",
      },
      {
        href: "/admin/assistants",
        title: "AI Assistants",
        description: "Manage AI assistants created with the Assistant Architect",
        icon: Bot,
        slug: "assistants",
      },
      {
        href: "/admin/prompts",
        title: "Prompt Moderation",
        description: "Review and moderate public prompt library submissions",
        icon: Flag,
        slug: "prompts",
      },
      {
        href: "/admin/repositories",
        title: "Repositories",
        description: "View and manage all knowledge repositories across the platform",
        icon: Library,
        slug: "repositories",
      },
      {
        href: "/admin/atrium",
        title: "Atrium Oversight",
        description:
          "Approve or deny public-publish requests and review the content audit trail",
        icon: BookOpenCheck,
        slug: "atrium",
      },
    ],
  },
  {
    label: "Agent Platform",
    colors: { bg: "bg-[#E8927C]/15", text: "text-[#E8927C]", icon: "#E8927C" },
    pages: [
      {
        href: "/admin/agents",
        title: "Agent Dashboard",
        description:
          "Monitor agent usage, adoption, safety signals, and user feedback",
        icon: Gauge,
        slug: "agents",
      },
      {
        href: "/admin/agents/skills/review",
        title: "Skill Review Queue",
        description: "Review flagged and user-submitted agent skills",
        icon: ClipboardList,
        slug: "skills-review",
      },
    ],
  },
  {
    label: "Platform & Observability",
    colors: {
      bg: "bg-[var(--brand-primary)]/10",
      text: "text-[var(--brand-primary)]",
      icon: "var(--brand-primary)",
    },
    pages: [
      {
        href: "/admin/activity",
        title: "Activity Dashboard",
        description:
          "Monitor platform usage across Nexus, Assistant Architect, and Model Compare",
        icon: Activity,
        slug: "activity",
      },
      {
        href: "/admin/settings",
        title: "System Settings",
        description: "Manage API keys and configuration values for the application",
        icon: Settings,
        slug: "settings",
      },
      {
        href: "/admin/navigation",
        title: "Navigation Structure",
        description: "Manage the sidebar navigation items and their role gating",
        icon: Compass,
        slug: "navigation",
      },
      {
        href: "/admin/connectors",
        title: "MCP Connectors",
        description: "Manage MCP servers available as connectors in Nexus Chat",
        icon: Plug,
        slug: "connectors",
      },
      {
        href: "/admin/tools",
        title: "Tool Versions",
        description:
          "Inspect tool catalog versions, deprecation state, and usage",
        icon: Wrench,
        slug: "tools",
      },
      {
        href: "/admin/graph",
        title: "Context Graph",
        description: "Manage context graph nodes and their connections",
        icon: GitBranch,
        slug: "graph",
      },
    ],
  },
]
