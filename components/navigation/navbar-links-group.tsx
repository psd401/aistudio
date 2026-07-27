'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { ChevronRight } from 'lucide-react';
import { iconMap, IconName } from './icon-map';
import { AnimatePresence, motion } from 'framer-motion';

const labelVariants = {
  collapsed: { opacity: 0, width: 0 },
  expanded: { opacity: 1, width: "auto" }
};

interface NavigationLink {
  label: string;
  link: string;
  description?: string;
  icon?: IconName;
}

interface LinksGroupProps {
  icon: React.FC<{ className?: string }>;
  label: string;
  type?: 'link' | 'section' | 'page';
  links?: NavigationLink[];
  link?: string;
  isExpanded: boolean;
}

function NavigationItems({
  links,
  isPage,
}: {
  links: NavigationLink[];
  isPage: boolean;
}) {
  return links.map((navigationLink) => {
    const LinkIcon = navigationLink.icon ? iconMap[navigationLink.icon] : null;
    if (isPage) {
      return (
        <Link
          href={navigationLink.link}
          key={navigationLink.label}
          className="block p-4 rounded-lg border bg-card text-card-foreground hover:bg-accent transition-colors"
        >
          <div className="flex items-center gap-2 mb-2">
            {LinkIcon && (
              <div className="flex h-8 w-8 items-center justify-center rounded-lg border bg-background">
                <LinkIcon className="h-4 w-4" />
              </div>
            )}
            <span className="font-medium">{navigationLink.label}</span>
          </div>
          {navigationLink.description && (
            <p className="text-sm text-muted-foreground">
              {navigationLink.description}
            </p>
          )}
        </Link>
      );
    }
    return (
      <Link
        href={navigationLink.link}
        key={navigationLink.label}
        className={cn(
          "block py-1.5 text-sm text-muted-foreground transition-colors rounded-sm",
          "hover:bg-accent/50 hover:text-foreground",
          "px-3"
        )}
      >
        {navigationLink.label}
      </Link>
    );
  });
}

function NavigationButtonContent({
  Icon,
  label,
  isExpanded,
  isDropdownOpen,
}: {
  Icon: LinksGroupProps["icon"];
  label: string;
  isExpanded: boolean;
  isDropdownOpen?: boolean;
}) {
  return (
    <div className="flex items-center w-full justify-start">
      <div className="flex h-7 w-7 items-center justify-center rounded-lg border bg-background flex-shrink-0 mr-3">
        <Icon className="h-4 w-4" />
      </div>
      <AnimatePresence>
        {isExpanded && (
          <>
            <motion.span
              variants={labelVariants}
              initial="collapsed"
              animate="expanded"
              exit="collapsed"
              className="text-sm font-medium overflow-hidden whitespace-nowrap"
            >
              {label}
            </motion.span>
            {isDropdownOpen !== undefined && (
              <ChevronRight
                className={cn(
                  "h-4 w-4 transition-transform ml-auto",
                  isDropdownOpen && "rotate-90"
                )}
              />
            )}
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

export function LinksGroup({ icon: Icon, label, type = 'link', links, link, isExpanded }: LinksGroupProps) {
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  const hasLinks = Array.isArray(links) && links.length > 0;
  const isDirectLink = !!link && !hasLinks;
  const isPage = type === 'page';

  const items = <NavigationItems links={hasLinks ? links : []} isPage={isPage} />;

  // If it's a direct link (no dropdown)
  if (isDirectLink) {
    return (
      <Link href={link} className="block w-full">
        <Button
          variant="ghost"
          className={cn(
            "w-full h-10 font-normal transition-colors duration-100 rounded-md",
            "hover:bg-accent hover:text-accent-foreground",
            "px-3 justify-start"
          )}
        >
          <NavigationButtonContent
            Icon={Icon}
            label={label}
            isExpanded={isExpanded}
          />
        </Button>
      </Link>
    );
  }

  // If it has child links (dropdown)
  return (
    <Collapsible
      open={isDropdownOpen}
      onOpenChange={setIsDropdownOpen}
      className="relative"
    >
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          className={cn(
            "w-full h-10 font-normal transition-colors duration-100 rounded-md",
            "hover:bg-accent hover:text-accent-foreground",
            "px-3 justify-start"
          )}
        >
          <NavigationButtonContent
            Icon={Icon}
            label={label}
            isExpanded={isExpanded}
            isDropdownOpen={isDropdownOpen}
          />
        </Button>
      </CollapsibleTrigger>
      
      {/* Show dropdown content differently based on expanded state */}
      <CollapsibleContent 
        className={cn(
          isExpanded 
            ? "space-y-0.5 pl-3"
            : cn( // Flyout menu when collapsed
              "absolute left-full top-0 min-w-[200px] bg-background border rounded-lg shadow-lg ml-2 py-2 z-50",
              "left-[calc(100%+0.5rem)]",
              isPage && "grid grid-cols-1 sm:grid-cols-2 gap-2 p-2"
            )
        )}
      >
        {items}
      </CollapsibleContent>
    </Collapsible>
  );
}
