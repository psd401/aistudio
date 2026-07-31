'use client';

/**
 * Dashboard home — Meridian design language, AI Studio palette.
 *
 * Ported from the original card grid as the first non-Atrium surface to adopt
 * Meridian (see `styles/app-meridian.css` for the token derivation). What was
 * deliberately dropped, and why:
 *
 *  - The four-colour accent rainbow (navy / coral / purple / green, with three
 *    hardcoded hexes) → a single brand tint. Meridian's discipline is brand +
 *    neutral; violet is reserved for AI-agent presence and nothing else.
 *  - `rounded-2xl` / `rounded-full` / `rounded-xl` on three sibling elements →
 *    the Meridian radius scale (`--mer-r-card` 15, `--mer-r-button` 9,
 *    `--mer-r-chip` 7).
 *  - `border-border/40` → `hover:border-border/60` → opaque hairline borders.
 *    Opacity-washed borders are the main reason the old grid read as soft.
 *  - `shadow-sm` → `hover:shadow-lg` plus `hover:-translate-y-0.5` → a border
 *    colour change only. Meridian cards do not lift or bloom.
 *  - Decorative `rounded-br-[80px]` gradient corner blobs → removed outright.
 *  - Hardcoded page background `#FBF7F4` → `--mer-canvas`.
 *  - Pill CTA on every card → a text CTA, with the filled button reserved for
 *    the single featured action. Meridian spends emphasis, it does not spray it.
 */

import { useMemo } from 'react';
import { useSession } from 'next-auth/react';
import Image from 'next/image';
import Link from 'next/link';
import {
  IconMessageCircle,
  IconUsers,
  IconClipboardList,
  IconGitBranch,
  IconTools,
  IconSchool,
  IconSearch,
} from '@tabler/icons-react';
import { useBranding } from '@/contexts/branding-context';

interface ToolCardProps {
  title: string;
  description: string;
  href: string;
  icon: React.ReactNode;
  ctaText?: string;
  featured?: boolean;
}

/**
 * Conversation motif for the featured card. Retained from the original (it is
 * the one decorative element that carries meaning) but re-grounded on
 * `--mer-brand` instead of `--brand-primary`, and no longer scales on hover —
 * Meridian's hover vocabulary is colour, not motion.
 */
function ChatBubbleGraphic() {
  return (
    <div
      className="relative w-[150px] flex-shrink-0 hidden sm:flex items-center justify-center overflow-hidden"
      style={{ background: 'var(--mer-brand)' }}
    >
      <svg
        viewBox="0 0 180 280"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="w-full h-full opacity-90"
        aria-hidden="true"
      >
        {/* AI response bubble */}
        <rect x="30" y="50" width="120" height="60" rx="14" fill="white" fillOpacity="0.18" />
        <rect x="46" y="68" width="72" height="6" rx="3" fill="white" fillOpacity="0.3" />
        <rect x="46" y="82" width="88" height="6" rx="3" fill="white" fillOpacity="0.25" />
        <rect x="46" y="96" width="52" height="6" rx="3" fill="white" fillOpacity="0.2" />

        {/* User message bubble */}
        <rect x="20" y="130" width="90" height="44" rx="12" fill="white" fillOpacity="0.14" />
        <rect x="34" y="145" width="56" height="5" rx="2.5" fill="white" fillOpacity="0.25" />
        <rect x="34" y="156" width="36" height="5" rx="2.5" fill="white" fillOpacity="0.2" />

        {/* Typing indicator — static dots under prefers-reduced-motion */}
        <rect x="55" y="194" width="72" height="36" rx="10" fill="white" fillOpacity="0.11" />
        <circle cx="77" cy="212" r="4" fill="white" fillOpacity="0.35">
          <animate attributeName="opacity" values="0.2;0.5;0.2" dur="1.5s" repeatCount="indefinite" begin="0s" />
        </circle>
        <circle cx="93" cy="212" r="4" fill="white" fillOpacity="0.35">
          <animate attributeName="opacity" values="0.2;0.5;0.2" dur="1.5s" repeatCount="indefinite" begin="0.3s" />
        </circle>
        <circle cx="109" cy="212" r="4" fill="white" fillOpacity="0.35">
          <animate attributeName="opacity" values="0.2;0.5;0.2" dur="1.5s" repeatCount="indefinite" begin="0.6s" />
        </circle>
      </svg>
    </div>
  );
}

function FeaturedToolCard({ title, description, href, icon, ctaText }: ToolCardProps) {
  return (
    <Link href={href} className="mer-card mer-card-link h-full overflow-hidden">
      {/* Centred rather than pinned top-and-bottom: `justify-between` on this
          little copy leaves a dead gap whenever the card is taller than its
          content. */}
      <div className="flex flex-col sm:flex-row flex-1">
        <div className="flex flex-col justify-center flex-1 p-5">
          <span className="mer-icon-chip mer-icon-chip-sm mb-3">{icon}</span>
          <h3 className="mer-card-title text-[17px] mb-1">{title}</h3>
          <p className="mer-card-desc max-w-[46ch]">{description}</p>
          <span className="mer-btn mer-btn-primary mt-4 w-fit">
            {ctaText || 'Get started'}
            <span aria-hidden="true">&rarr;</span>
          </span>
        </div>
        <ChatBubbleGraphic />
      </div>
    </Link>
  );
}

function StandardToolCard({ title, description, href, icon, ctaText }: ToolCardProps) {
  return (
    <Link href={href} className="mer-card mer-card-link h-full p-4">
      <span className="mer-icon-chip mer-icon-chip-sm mb-2.5">{icon}</span>
      <h3 className="mer-card-title mb-0.5">{title}</h3>
      <p className="mer-card-desc flex-1">{description}</p>
      {ctaText && (
        <span className="mer-card-cta mt-3">
          {ctaText}
          <span aria-hidden="true">&rarr;</span>
        </span>
      )}
    </Link>
  );
}

function ToolCard(props: ToolCardProps) {
  return props.featured ? <FeaturedToolCard {...props} /> : <StandardToolCard {...props} />;
}

interface DashboardHeaderProps {
  firstName: string;
  orgName: string;
  appName: string;
  logoSrc: string;
  logoIsExternal: boolean;
}

function DashboardHeader({ firstName, orgName, appName, logoSrc, logoIsExternal }: DashboardHeaderProps) {
  return (
    <div className="mb-5">
      <div className="flex items-center gap-2 mb-1.5">
        <Image
          src={logoSrc}
          alt=""
          width={18}
          height={18}
          className="opacity-60"
          unoptimized={logoIsExternal}
          aria-hidden="true"
        />
        <span
          className="text-[11px] uppercase font-semibold"
          style={{ color: 'var(--mer-ink-muted)', letterSpacing: '0.07em' }}
        >
          {orgName} · {appName}
        </span>
      </div>
      <h1
        className="text-[27px] sm:text-[30px] font-normal leading-[1.15]"
        style={{ color: 'var(--mer-ink)', letterSpacing: '-0.022em' }}
      >
        Welcome back, <span className="font-semibold">{firstName}</span>
      </h1>
    </div>
  );
}

function SearchBar() {
  return (
    <div className="mb-7">
      <label className="mer-search" style={{ maxWidth: 'none', height: 42 }} htmlFor="dashboard-search">
        <IconSearch size={18} className="mer-search-icon" aria-hidden="true" />
        <input
          id="dashboard-search"
          type="search"
          placeholder="Search tools, prompts, or assistants…"
          aria-label="Search tools, prompts, or assistants"
          className="mer-search-input"
        />
      </label>
    </div>
  );
}

// Hoisted so the icons are not re-created as JSX props on every render.
const NexusChatIcon = <IconMessageCircle size={19} />;
const AssistantCatalogIcon = <IconUsers size={18} />;
const PromptLibraryIcon = <IconClipboardList size={18} />;
const ModelCompareIcon = <IconGitBranch size={18} />;
const AssistantArchitectIcon = <IconTools size={18} />;
const TutorialsIcon = <IconSchool size={18} />;

function ToolCardsGrid() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 auto-rows-auto">
      {/*
        3 cols × 2 rows. This is what makes the grid close cleanly: featured(3) +
        catalog(2) + library(2) fill the first block, and compare(1) +
        architect(2) + tutorials(2) fill the second row exactly. Dropping the row
        span reflows it into a stretched catalog card and an orphaned tutorials
        card on a row of its own.
      */}
      <div className="lg:col-span-3 lg:row-span-2">
        <ToolCard
          title="Nexus Chat"
          description="Start a conversation with advanced language models for brainstorming, planning, and classroom assistance."
          href="/nexus"
          icon={NexusChatIcon}
          ctaText="Start chatting"
          featured
        />
      </div>

      <div className="lg:col-span-2">
        <ToolCard
          title="Assistant Catalog"
          description="Find ready-to-use specialized assistants."
          href="/utilities/assistant-catalog"
          icon={AssistantCatalogIcon}
          ctaText="Browse"
        />
      </div>

      <div className="lg:col-span-2">
        <ToolCard
          title="Prompt Library"
          description="Browse pre-built educational prompts."
          href="/prompt-library"
          icon={PromptLibraryIcon}
          ctaText="Browse"
        />
      </div>

      <div className="lg:col-span-1">
        <ToolCard
          title="Model Compare"
          description="Compare outputs side-by-side."
          href="/compare"
          icon={ModelCompareIcon}
          ctaText="Launch"
        />
      </div>

      <div className="lg:col-span-2">
        <ToolCard
          title="Assistant Architect"
          description="Build your own custom AI helper."
          href="/utilities/assistant-architect"
          icon={AssistantArchitectIcon}
          ctaText="Create new"
        />
      </div>

      <div className="lg:col-span-2">
        <ToolCard
          title="Tutorials"
          description="Learn how to use AI effectively."
          href="/tutorials"
          icon={TutorialsIcon}
          ctaText="Start learning"
        />
      </div>
    </div>
  );
}

export function DashboardHome() {
  const { data: session } = useSession();
  const { orgName, appName, logoSrc, logoIsExternal } = useBranding();

  const firstName = useMemo(() => {
    return session?.user?.givenName || session?.user?.name?.split(' ')[0] || 'there';
  }, [session?.user?.givenName, session?.user?.name]);

  return (
    <div className="mer-page">
      <div className="mer-page-inner">
        <DashboardHeader
          firstName={firstName}
          orgName={orgName}
          appName={appName}
          logoSrc={logoSrc}
          logoIsExternal={logoIsExternal}
        />
        <SearchBar />
        <div className="mer-section-head">
          <h2 className="mer-section-title">Featured tools</h2>
          <Link href="/utilities/assistant-catalog" className="mer-section-link">
            View all
            <span aria-hidden="true">&rarr;</span>
          </Link>
        </div>
        <ToolCardsGrid />
      </div>
    </div>
  );
}
