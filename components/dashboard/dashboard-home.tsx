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
  image?: string;
}

const ACCENT_CLASSES: Record<AccentColor, string> = {
  navy: 'from-[#1B365D]/10 to-transparent',
  coral: 'from-[#E8927C]/15 to-transparent',
  purple: 'from-[#7B68A6]/15 to-transparent',
  green: 'from-[#6B9E78]/15 to-transparent',
};

const ICON_BG_CLASSES: Record<AccentColor, string> = {
  navy: 'bg-[#1B365D]/10 text-[#1B365D]',
  coral: 'bg-[#E8927C]/15 text-[#E8927C]',
  purple: 'bg-[#7B68A6]/15 text-[#7B68A6]',
  green: 'bg-[#6B9E78]/15 text-[#6B9E78]',
};

const CTA_COLOR_CLASSES: Record<AccentColor, string> = {
  navy: 'text-[#1B365D]',
  coral: 'text-[#E8927C]',
  purple: 'text-[#7B68A6]',
  green: 'text-[#6B9E78]',
};

function FeaturedToolCard({ title, description, href, icon, ctaText, accentColor, image }: ToolCardProps) {
  return (
    <Link
      href={href}
      className={cn(
        'group relative flex flex-col bg-white rounded-2xl overflow-hidden',
        'border border-border/40 shadow-sm',
        'transition-all duration-200 ease-out',
        'hover:shadow-lg hover:border-border/60 hover:-translate-y-0.5',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1B365D] focus-visible:ring-offset-2',
        'h-full min-h-[280px]'
      )}
    >
      <div className="flex flex-1">
        <div className="flex flex-col justify-between p-6 flex-1">
          <div>
            <div className={cn('inline-flex p-2 rounded-lg mb-3', ICON_BG_CLASSES[accentColor])}>
              {icon}
            </div>
            <h3 className="text-lg font-bold text-[#1B365D] mb-2">{title}</h3>
            <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
          </div>
          <span
            className={cn(
              'mt-4 inline-flex items-center gap-2 px-5 py-2.5 rounded-full',
              'bg-[#1B365D] text-white text-sm font-medium',
              'transition-all duration-200',
              'group-hover:bg-[#1B365D]/90',
              'w-fit'
            )}
          >
            {ctaText || 'Get Started'}
            <span className="transition-transform group-hover:translate-x-0.5">&rarr;</span>
          </span>
        </div>
        {image && (
          <div className="relative w-[180px] flex-shrink-0 bg-[#1B365D]/95 hidden sm:block">
            <Image src={image} alt="" fill className="object-contain p-4 opacity-90" sizes="180px" />
          </div>
        )}
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
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1B365D] focus-visible:ring-offset-2',
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
}

function DashboardHeader({ firstName }: DashboardHeaderProps) {
  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-1">
        <Image src="/logo.png" alt="" width={20} height={20} className="opacity-70" />
        <span className="text-xs uppercase tracking-wider text-muted-foreground font-medium">
          Peninsula School District - AI Studio
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
      <IconSearch size={20} className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground" />
      <input
        type="search"
        placeholder="Search tools, prompts, or assistants..."
        className={cn(
          'w-full h-12 pl-12 pr-4 rounded-xl',
          'bg-white border border-border/40 shadow-sm',
          'text-sm placeholder:text-muted-foreground',
          'focus:outline-none focus:ring-2 focus:ring-[#1B365D]/20 focus:border-[#1B365D]/40',
          'transition-all duration-200'
        )}
      />
    </div>
  );
}

function FeaturedToolsHeader() {
  return (
    <div className="flex items-center justify-between mb-4">
      <h2 className="text-lg font-bold text-[#1B365D]">Featured Tools</h2>
      <Link
        href="#"
        className="text-sm text-[#1B365D] hover:text-[#1B365D]/80 font-medium flex items-center gap-1"
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
          image="/psd-ai-logo.png"
        />
      </div>

      {/* Assistant Catalog */}
      <div className="lg:col-span-2">
        <ToolCard
          title="Assistant Catalog"
          description="Find ready-to-use specialized assistants."
          href="#"
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
          href="#"
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

  const firstName = useMemo(() => {
    return session?.user?.givenName || session?.user?.name?.split(' ')[0] || 'there';
  }, [session?.user?.givenName, session?.user?.name]);

  return (
    <div className="min-h-screen bg-[#FBF7F4]">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <DashboardHeader firstName={firstName} />
        <SearchBar />
        <FeaturedToolsHeader />
        <ToolCardsGrid />
      </div>
    </div>
  );
}
