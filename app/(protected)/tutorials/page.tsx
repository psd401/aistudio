'use client';

import Link from 'next/link';
import {
  IconSearch,
  IconFileTypePdf,
  IconExternalLink,
  IconPlayerPlay,
  IconClock,
} from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import { PageBranding } from '@/components/ui/page-branding';

// Types
interface VideoTutorial {
  id: string;
  title: string;
  description?: string;
  thumbnailUrl?: string;
  embedUrl?: string;
  duration?: string;
  featured?: boolean;
}

interface WrittenResource {
  id: string;
  title: string;
  description: string;
  type: 'pdf' | 'link';
  url: string;
}

// Featured video with actual Canva embed
const FEATURED_VIDEO: VideoTutorial = {
  id: 'featured-1',
  title: 'AI Studio Tutorial - Intro to Nexus',
  description: 'Learn how to use Nexus Chat to create engaging lesson plans, generate classroom activities, and streamline your planning workflow.',
  embedUrl: 'https://www.canva.com/design/DAG6qpryQo4/JWLRUS4gvagOLnA-xyi5uQ/watch?embed',
  featured: true,
};

// Video tutorials - add embedUrl when videos are ready
const VIDEO_TUTORIALS: VideoTutorial[] = [
  {
    id: 'video-1',
    title: 'Intro to Prompt Library',
    embedUrl: 'https://www.canva.com/design/DAG7PR_eCKM/0qGJbjZBlwGQfsuDzwkKow/watch?embed',
  },
  {
    id: 'video-2',
    title: 'Intro to Reporting Bugs',
    embedUrl: 'https://www.canva.com/design/DAG8Rogy5Cw/IA5mq1K1Cs0XLuvvtV0D8Q/watch?embed',
  },
  {
    id: 'video-3',
    title: 'Using Model Compare for Feedback',
    duration: '6:42',
  },
  {
    id: 'video-4',
    title: 'Getting Started with Assistant Architect',
    duration: '10:20',
  },
];

const WRITTEN_RESOURCES: WrittenResource[] = [
  {
    id: 'resource-1',
    title: 'AI Studio Quick Start Guide',
    description: 'A comprehensive PDF guide to get you started with AI Studio in minutes.',
    type: 'pdf',
    url: '/docs/ai-studio-quick-start.pdf', // Replace with actual path
  },
  {
    id: 'resource-2',
    title: 'Prompt Engineering Best Practices',
    description: 'Learn the art of crafting effective prompts for better AI responses.',
    type: 'pdf',
    url: '/docs/prompt-engineering-guide.pdf', // Replace with actual path
  },
  {
    id: 'resource-3',
    title: 'AI in Education Resources',
    description: 'Explore curated resources from leading education technology experts.',
    type: 'link',
    url: 'https://www.iste.org/areas-of-focus/AI-in-education', // Example link
  },
  {
    id: 'resource-4',
    title: 'Classroom AI Integration Tips',
    description: 'Practical strategies for incorporating AI tools into your teaching.',
    type: 'link',
    url: 'https://www.edutopia.org/topic/technology-integration', // Example link
  },
];

function SearchBar() {
  return (
    <div className="relative mb-8">
      <IconSearch size={20} className="absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground" />
      <input
        type="search"
        placeholder="Search tutorials..."
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

function VideoThumbnail({ video, size = 'normal' }: { video: VideoTutorial; size?: 'featured' | 'normal' }) {
  const isFeatured = size === 'featured';

  return (
    <div
      className={cn(
        'relative bg-[#1B365D]/10 rounded-xl overflow-hidden group cursor-pointer',
        isFeatured ? 'aspect-video' : 'aspect-video'
      )}
    >
      {/* Placeholder background with play icon */}
      <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-[#1B365D]/80 to-[#1B365D]/95">
        <div className="flex flex-col items-center gap-2">
          <div
            className={cn(
              'rounded-full bg-white/20 flex items-center justify-center',
              'group-hover:bg-white/30 transition-colors',
              isFeatured ? 'w-16 h-16' : 'w-12 h-12'
            )}
          >
            <IconPlayerPlay
              size={isFeatured ? 32 : 24}
              className="text-white ml-1"
            />
          </div>
          <span className="text-white/80 text-sm font-medium">Click to play</span>
        </div>
      </div>

      {/* Duration badge */}
      {video.duration && (
        <div className="absolute bottom-2 right-2 px-2 py-1 bg-black/70 rounded text-xs text-white font-medium flex items-center gap-1">
          <IconClock size={12} />
          {video.duration}
        </div>
      )}
    </div>
  );
}

function FeaturedVideoCard({ video }: { video: VideoTutorial }) {
  return (
    <div className="bg-white rounded-2xl border border-border/40 shadow-sm overflow-hidden mb-8">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-0">
        {/* Video Embed - aspect-video gives 16:9 ratio */}
        <div className="relative w-full aspect-video">
          {video.embedUrl ? (
            <iframe
              title={video.title}
              loading="lazy"
              className="absolute top-0 left-0 w-full h-full border-0"
              src={video.embedUrl}
              allowFullScreen
              allow="fullscreen"
            />
          ) : (
            <VideoThumbnail video={video} size="featured" />
          )}
        </div>
        <div className="p-6 lg:p-8 flex flex-col justify-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 bg-[#E8927C]/15 text-[#E8927C] rounded-full text-sm font-medium w-fit mb-4">
            <IconPlayerPlay size={14} />
            Featured Tutorial
          </div>
          <h2 className="text-xl lg:text-2xl font-bold text-[#1B365D] mb-3">
            {video.title}
          </h2>
          <p className="text-muted-foreground leading-relaxed">
            {video.description}
          </p>
        </div>
      </div>
    </div>
  );
}

function VideoCard({ video }: { video: VideoTutorial }) {
  return (
    <div
      className={cn(
        'bg-white rounded-2xl border border-border/40 shadow-sm overflow-hidden',
        'transition-all duration-200 ease-out',
        !video.embedUrl && 'hover:shadow-lg hover:border-border/60 hover:-translate-y-0.5'
      )}
    >
      {video.embedUrl ? (
        <div className="relative w-full aspect-video">
          <iframe
            title={video.title}
            loading="lazy"
            className="absolute top-0 left-0 w-full h-full border-0"
            src={video.embedUrl}
            allowFullScreen
            allow="fullscreen"
          />
        </div>
      ) : (
        <VideoThumbnail video={video} />
      )}
      <div className="p-4">
        <h3 className="font-semibold text-foreground line-clamp-2">
          {video.title}
        </h3>
      </div>
    </div>
  );
}

function ResourceCard({ resource }: { resource: WrittenResource }) {
  const Icon = resource.type === 'pdf' ? IconFileTypePdf : IconExternalLink;
  const iconBgColor = resource.type === 'pdf' ? 'bg-red-100 text-red-600' : 'bg-blue-100 text-blue-600';

  return (
    <Link
      href={resource.url}
      target={resource.type === 'link' ? '_blank' : undefined}
      rel={resource.type === 'link' ? 'noopener noreferrer' : undefined}
      className={cn(
        'group bg-white rounded-2xl border border-border/40 shadow-sm p-5',
        'transition-all duration-200 ease-out',
        'hover:shadow-lg hover:border-border/60 hover:-translate-y-0.5',
        'flex items-start gap-4'
      )}
    >
      <div className={cn('p-3 rounded-xl', iconBgColor)}>
        <Icon size={24} />
      </div>
      <div className="flex-1 min-w-0">
        <h3 className="font-semibold text-foreground mb-1 group-hover:text-[#1B365D] transition-colors">
          {resource.title}
        </h3>
        <p className="text-sm text-muted-foreground line-clamp-2">
          {resource.description}
        </p>
      </div>
      <span className="text-muted-foreground/60 group-hover:text-[#1B365D] group-hover:translate-x-0.5 transition-all">
        &rarr;
      </span>
    </Link>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <h2 className="text-lg font-bold text-[#1B365D] mb-4">
      {title}
    </h2>
  );
}

export default function TutorialsPage() {
  return (
    <div className="min-h-screen bg-[#FBF7F4]">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Header */}
        <div className="mb-6">
          <PageBranding />
          <h1 className="text-2xl sm:text-3xl font-bold text-[#1B365D]">
            AI Studio Tutorials Library
          </h1>
          <p className="text-muted-foreground mt-1">
            Video tutorials and resources to help you get the most out of AI Studio
          </p>
        </div>

        {/* Search Bar */}
        <SearchBar />

        {/* Featured Video */}
        <FeaturedVideoCard video={FEATURED_VIDEO} />

        {/* Video Tutorials Grid */}
        <div className="mb-10">
          <SectionHeader title="Video Tutorials" />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {VIDEO_TUTORIALS.map((video) => (
              <VideoCard key={video.id} video={video} />
            ))}
          </div>
        </div>

        {/* Written Guides & Documentation */}
        <div>
          <SectionHeader title="Written Guides & Documentation" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {WRITTEN_RESOURCES.map((resource) => (
              <ResourceCard key={resource.id} resource={resource} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
