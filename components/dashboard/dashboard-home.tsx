'use client';

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
import { cn } from '@/lib/utils';
import { useBranding } from '@/contexts/branding-context';

type AccentColor = 'navy' | 'coral' | 'purple' | 'green';

interface ToolCardProps {
  title: string;
  description: string;
  href: string;
  icon: React.ReactNode;
  ctaText?: string;
  ctaColor?: AccentColor;
  accentColor: AccentColor;
  featured?: boolean;
}

const ACCENT_CLASSES: Record<AccentColor, string> = {
  navy: 'from-[var(--brand-primary)]/10 to-transparent',
  coral: 'from-[#E8927C]/15 to-transparent',
  purple: 'from-[#7B68A6]/15 to-transparent',
  green: 'from-[#6B9E78]/15 to-transparent',
};

const ICON_BG_CLASSES: Record<AccentColor, string> = {
  navy: 'bg-[var(--brand-primary)]/10 text-[var(--brand-primary)]',
  coral: 'bg-[#E8927C]/15 text-[#E8927C]',
  purple: 'bg-[#7B68A6]/15 text-[#7B68A6]',
  green: 'bg-[#6B9E78]/15 text-[#6B9E78]',
};

const CTA_COLOR_CLASSES: Record<AccentColor, string> = {
  navy: 'text-[var(--brand-primary)]',
  coral: 'text-[#E8927C]',
  purple: 'text-[#7B68A6]',
  green: 'text-[#6B9E78]',
};

function ChatBubbleGraphic() {
  return (
    <div className="relative w-[180px] flex-shrink-0 bg-[var(--brand-primary)] hidden sm:flex items-center justify-center overflow-hidden">
      {/* Subtle radial glow */}
      <div className="absolute inset-0 bg-gradient-to-br from-white/10 via-transparent to-black/10" />
      <svg
        viewBox="0 0 180 280"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="w-full h-full opacity-90 motion-safe:transition-transform motion-safe:duration-500 group-hover:motion-safe:scale-105"
        aria-hidden="true"
      >
        {/* Large chat bubble - right aligned (AI response) */}
        <rect x="30" y="50" width="120" height="60" rx="16" fill="white" fillOpacity="0.2" />
        {/* Text lines inside large bubble */}
        <rect x="46" y="68" width="72" height="6" rx="3" fill="white" fillOpacity="0.3" />
        <rect x="46" y="82" width="88" height="6" rx="3" fill="white" fillOpacity="0.25" />
        <rect x="46" y="96" width="52" height="6" rx="3" fill="white" fillOpacity="0.2" />

        {/* Small chat bubble - left aligned (user message) */}
        <rect x="20" y="130" width="90" height="44" rx="14" fill="white" fillOpacity="0.15" />
        <rect x="34" y="145" width="56" height="5" rx="2.5" fill="white" fillOpacity="0.25" />
        <rect x="34" y="156" width="36" height="5" rx="2.5" fill="white" fillOpacity="0.2" />

        {/* Typing indicator bubble — static dots when prefers-reduced-motion is set */}
        <rect x="55" y="194" width="72" height="36" rx="12" fill="white" fillOpacity="0.12" />
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

function FeaturedToolCard({ title, description, href, icon, ctaText, accentColor }: ToolCardProps) {
  return (
    <Link
      href={href}
      className={cn(
        'group relative flex flex-col bg-white rounded-2xl overflow-hidden',
        'border border-border/40 shadow-sm',
        'transition-all duration-200 ease-out',
        'hover:shadow-lg hover:border-border/60 hover:-translate-y-0.5',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)] focus-visible:ring-offset-2',
        'h-full min-h-[280px]'
      )}
    >
      <div className="flex flex-1">
        <div className="flex flex-col justify-between p-6 flex-1">
          <div>
            <div className={cn('inline-flex p-2 rounded-lg mb-3', ICON_BG_CLASSES[accentColor])}>
              {icon}
            </div>
            <h3 className="text-lg font-bold text-[var(--brand-primary)] mb-2">{title}</h3>
            <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
          </div>
          <span
            className={cn(
              'mt-4 inline-flex items-center gap-2 px-5 py-2.5 rounded-full',
              'bg-[var(--brand-primary)] text-white text-sm font-medium',
              'transition-all duration-200',
              'group-hover:bg-[var(--brand-primary)]/90',
              'w-fit'
            )}
          >
            {ctaText || 'Get Started'}
            <span className="motion-safe:transition-transform group-hover:translate-x-0.5 group-focus-visible:translate-x-0.5">&rarr;</span>
          </span>
        </div>
        <ChatBubbleGraphic />
      </div>
    </Link>
  );
}

function StandardToolCard({ title, description, href, icon, ctaText, ctaColor, accentColor }: ToolCardProps) {
  const effectiveCtaColor = ctaColor || accentColor;

  return (
    <Link
      href={href}
      className={cn(
        'group relative flex flex-col bg-white rounded-2xl overflow-hidden',
        'border border-border/40 shadow-sm p-5',
        'transition-all duration-200 ease-out',
        'hover:shadow-lg hover:border-border/60 hover:-translate-y-0.5',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-primary)] focus-visible:ring-offset-2',
        'h-full min-h-[140px]'
      )}
    >
      <div
        className={cn(
          'absolute top-0 left-0 w-24 h-24 rounded-br-[80px]',
          'bg-gradient-to-br',
          ACCENT_CLASSES[accentColor],
          'pointer-events-none'
        )}
      />
      <div className="relative z-10 flex flex-col h-full">
        <div className={cn('inline-flex p-2 rounded-full w-fit mb-3', ICON_BG_CLASSES[accentColor])}>
          {icon}
        </div>
        <h3 className="text-base font-bold text-foreground mb-1">{title}</h3>
        <p className="text-sm text-muted-foreground leading-relaxed flex-1">{description}</p>
        <div className="flex items-center justify-between mt-3">
          {ctaText && (
            <span className={cn('text-sm font-medium', CTA_COLOR_CLASSES[effectiveCtaColor])}>
              {ctaText}
            </span>
          )}
          <span
            className={cn(
              'ml-auto text-muted-foreground/60 transition-transform',
              'group-hover:translate-x-0.5 group-hover:text-muted-foreground'
            )}
          >
            &rarr;
          </span>
        </div>
      </div>
    </Link>
  );
}

function ToolCard(props: ToolCardProps) {
  if (props.featured) {
    return <FeaturedToolCard {...props} />;
  }
  return <StandardToolCard {...props} />;
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
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-1">
        <Image src={logoSrc} alt="" width={20} height={20} className="opacity-70" unoptimized={logoIsExternal} aria-hidden="true" />
        <span className="text-xs uppercase tracking-wider text-muted-foreground font-medium">
          {orgName} - {appName}
        </span>
      </div>
      <h1 className="text-2xl sm:text-3xl font-normal text-foreground">
        Welcome back, <span className="font-bold">{firstName}</span>
      </h1>
    </div>
  );
}

function SearchBar() {
  return (
    <div className="relative mb-8">
      <IconSearch size={20} className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <input
        id="dashboard-search"
        type="search"
        placeholder="Search tools, prompts, or assistants..."
        aria-label="Search tools, prompts, or assistants"
        className={cn(
          'w-full h-12 pl-12 pr-4 rounded-xl',
          'bg-white border border-border/40 shadow-sm',
          'text-sm placeholder:text-muted-foreground',
          'focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20 focus:border-[var(--brand-primary)]/40',
          'motion-safe:transition-all motion-safe:duration-200'
        )}
      />
    </div>
  );
}

function FeaturedToolsHeader() {
  return (
    <div className="flex items-center justify-between mb-4">
      <h2 className="text-lg font-bold text-[var(--brand-primary)]">Featured Tools</h2>
      <Link
        href="/utilities/assistant-catalog"
        className="text-sm text-[var(--brand-primary)] hover:text-[var(--brand-primary)]/80 font-medium flex items-center gap-1"
      >
        View All
        <span>&rarr;</span>
      </Link>
    </div>
  );
}

// Memoized icon components to avoid JSX-as-prop warning
const NexusChatIcon = <IconMessageCircle size={24} />;
const AssistantCatalogIcon = <IconUsers size={20} />;
const PromptLibraryIcon = <IconClipboardList size={20} />;
const ModelCompareIcon = <IconGitBranch size={20} />;
const AssistantArchitectIcon = <IconTools size={20} />;
const TutorialsIcon = <IconSchool size={20} />;

function ToolCardsGrid() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 auto-rows-auto">
      {/* Nexus Chat - spans 3 columns on large screens, 2 rows */}
      <div className="lg:col-span-3 lg:row-span-2">
        <ToolCard
          title="Nexus Chat"
          description="Start a conversation with advanced language models for brainstorming, planning, and classroom assistance."
          href="/nexus"
          icon={NexusChatIcon}
          accentColor="navy"
          ctaText="Start Chatting"
          featured
        />
      </div>

      {/* Assistant Catalog */}
      <div className="lg:col-span-2">
        <ToolCard
          title="Assistant Catalog"
          description="Find ready-to-use specialized assistants."
          href="/utilities/assistant-catalog"
          icon={AssistantCatalogIcon}
          accentColor="coral"
        />
      </div>

      {/* Prompt Library */}
      <div className="lg:col-span-2">
        <ToolCard
          title="Prompt Library"
          description="Browse pre-built educational prompts."
          href="/prompt-library"
          icon={PromptLibraryIcon}
          accentColor="coral"
        />
      </div>

      {/* Model Compare */}
      <div className="lg:col-span-1 xl:col-span-1">
        <ToolCard
          title="Model Compare"
          description="Compare outputs side-by-side."
          href="/compare"
          icon={ModelCompareIcon}
          accentColor="purple"
          ctaText="Launch Tool"
        />
      </div>

      {/* Assistant Architect */}
      <div className="lg:col-span-2 xl:col-span-2">
        <ToolCard
          title="Assistant Architect"
          description="Build your own custom AI helper."
          href="/utilities/assistant-architect"
          icon={AssistantArchitectIcon}
          accentColor="purple"
          ctaText="Create New"
        />
      </div>

      {/* Tutorials */}
      <div className="lg:col-span-2 xl:col-span-2">
        <ToolCard
          title="Tutorials"
          description="Learn how to use AI effectively."
          href="/tutorials"
          icon={TutorialsIcon}
          accentColor="green"
          ctaText="Start Learning"
          ctaColor="coral"
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
    <div className="min-h-screen bg-[#FBF7F4]">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <DashboardHeader firstName={firstName} orgName={orgName} appName={appName} logoSrc={logoSrc} logoIsExternal={logoIsExternal} />
        <SearchBar />
        <FeaturedToolsHeader />
        <ToolCardsGrid />
      </div>
    </div>
  );
}
