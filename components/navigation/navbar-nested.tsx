'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { motion, AnimatePresence } from 'framer-motion';
import { LogOut, Settings, Bug, LucideIcon, Image as ImageIcon, X } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { useNotifications } from '@/contexts/notification-context';
import { useExecutionResults } from '@/hooks/use-execution-results';
import { createFreshserviceTicketAction } from '@/actions/create-freshservice-ticket.actions';
import { createLogger } from '@/lib/client-logger';
import { NotificationBell } from '@/components/notifications/notification-bell';
import { MessageCenter } from '@/components/notifications/message-center';
import { iconMap, IconName } from './icon-map';
import { LinksGroup } from './navbar-links-group';
import { cn } from '@/lib/utils';

/**
 * Raw navigation item from the API
 */
interface NavigationItem {
  id: string;
  label: string;
  icon: IconName;
  link: string | null;
  description?: string;
  type: 'link' | 'section' | 'page';
  parent_id: string | null;
  parent_label: string | null;
  tool_id: string | null;
  position: number;
  color?: string;
}

/**
 * Processed navigation item for the UI
 */
interface ProcessedItem {
  id: string;
  label: string;
  icon: IconName;
  type: 'link' | 'section' | 'page';
  link?: string;
  links?: {
    label: string;
    link: string;
    description?: string;
    icon?: IconName;
    color?: string;
  }[];
  color?: string;
}

// Variants for sidebar animation
const sidebarVariants = {
  expanded: { width: '300px' },
  collapsed: { width: '68px' },
};

// Spring transition config
const springTransition = { type: 'spring' as const, stiffness: 300, damping: 30 };

// Animation variants for labels
const labelVariants = {
  collapsed: { opacity: 0, width: 0 },
  expanded: { opacity: 1, width: 'auto' },
};

interface NavbarNestedProps {
  fullHeight?: boolean;
}

export function NavbarNested({ fullHeight = false }: NavbarNestedProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const handleMouseEnter = useCallback(() => setIsExpanded(true), []);
  const handleMouseLeave = useCallback(() => setIsExpanded(false), []);

  return (
    <motion.nav
      initial={false}
      animate={isExpanded ? 'expanded' : 'collapsed'}
      variants={sidebarVariants}
      transition={springTransition}
      className={cn(
        'hidden lg:flex flex-col border-r bg-background fixed left-0 z-40',
        fullHeight ? 'h-dvh top-0' : 'h-[calc(100dvh-3.5rem)] top-14'
      )}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <NavigationContent isExpanded={isExpanded} />
    </motion.nav>
  );
}

// Sidebar utility link component
interface SidebarLinkProps {
  href: string;
  icon: LucideIcon;
  label: string;
  isExpanded: boolean;
}

function SidebarLink({ href, icon: Icon, label, isExpanded }: SidebarLinkProps) {
  return (
    <Link href={href} className="block w-full mb-2">
      <Button
        variant="ghost"
        className={cn(
          'w-full h-10 font-normal transition-colors duration-100 rounded-md',
          'hover:bg-accent hover:text-accent-foreground',
          isExpanded ? 'px-3 justify-start' : 'px-0 justify-center'
        )}
      >
        <div className={cn('flex items-center', isExpanded ? 'justify-start w-full' : 'justify-center')}>
          <div className="flex h-7 w-7 items-center justify-center rounded-lg border bg-background flex-shrink-0">
            <Icon className="h-4 w-4" />
          </div>
          <AnimatePresence>
            {isExpanded && (
              <motion.span
                variants={labelVariants}
                initial="collapsed"
                animate="expanded"
                exit="collapsed"
                className="ml-3 text-sm font-medium overflow-hidden whitespace-nowrap"
              >
                {label}
              </motion.span>
            )}
          </AnimatePresence>
        </div>
      </Button>
    </Link>
  );
}

// Sidebar button component (like SidebarLink but as a button with optional badge)
interface SidebarButtonProps {
  icon: LucideIcon;
  label: string;
  isExpanded: boolean;
  badgeCount?: number;
  onClick?: () => void;
}

function SidebarButton({ icon: Icon, label, isExpanded, badgeCount, onClick }: SidebarButtonProps) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      className={cn(
        'w-full h-10 font-normal transition-colors duration-100 rounded-md mb-2',
        'hover:bg-accent hover:text-accent-foreground',
        isExpanded ? 'px-3 justify-start' : 'px-0 justify-center'
      )}
    >
      <div className={cn('flex items-center', isExpanded ? 'justify-start w-full' : 'justify-center')}>
        <div className="relative flex h-7 w-7 items-center justify-center rounded-lg border bg-background flex-shrink-0">
          <Icon className="h-4 w-4" />
          {badgeCount !== undefined && badgeCount > 0 && (
            <Badge
              variant="destructive"
              className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full p-0 text-[10px] flex items-center justify-center"
            >
              {badgeCount > 99 ? '99+' : badgeCount}
            </Badge>
          )}
        </div>
        <AnimatePresence>
          {isExpanded && (
            <motion.span
              variants={labelVariants}
              initial="collapsed"
              animate="expanded"
              exit="collapsed"
              className="ml-3 text-sm font-medium overflow-hidden whitespace-nowrap"
            >
              {label}
            </motion.span>
          )}
        </AnimatePresence>
      </div>
    </Button>
  );
}

// Sidebar notifications wrapper
interface SidebarNotificationsProps {
  isExpanded: boolean;
}

function SidebarNotifications({ isExpanded }: SidebarNotificationsProps) {
  const { notifications, unreadCount, isLoading, markAsRead, markAllAsRead } = useNotifications();

  return (
    <div className={cn(
      'w-full mb-2',
      isExpanded ? 'px-0' : 'flex justify-center'
    )}>
      <div className={cn(
        'flex items-center gap-3 w-full',
        isExpanded ? '' : 'justify-center'
      )}>
        <NotificationBell
          unreadCount={unreadCount}
          notifications={notifications}
          onMarkRead={markAsRead}
          onMarkAllRead={markAllAsRead}
          loading={isLoading}
        />
        <AnimatePresence>
          {isExpanded && (
            <motion.span
              variants={labelVariants}
              initial="collapsed"
              animate="expanded"
              exit="collapsed"
              className="text-sm font-medium overflow-hidden whitespace-nowrap"
            >
              Notifications {unreadCount > 0 && `(${unreadCount})`}
            </motion.span>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// Sidebar messages wrapper
interface SidebarMessagesProps {
  isExpanded: boolean;
}

function SidebarMessages({ isExpanded }: SidebarMessagesProps) {
  const { results, isLoading } = useExecutionResults({ limit: 10 });

  const handleViewResult = (resultId: number) => {
    window.location.href = `/execution-results/${resultId}`;
  };

  return (
    <div className={cn(
      'w-full mb-2',
      isExpanded ? 'px-0' : 'flex justify-center'
    )}>
      <div className={cn(
        'flex items-center gap-3 w-full',
        isExpanded ? '' : 'justify-center'
      )}>
        <MessageCenter
          messages={results}
          onViewResult={handleViewResult}
          loading={isLoading}
        />
        <AnimatePresence>
          {isExpanded && (
            <motion.span
              variants={labelVariants}
              initial="collapsed"
              animate="expanded"
              exit="collapsed"
              className="text-sm font-medium overflow-hidden whitespace-nowrap"
            >
              Execution Results
            </motion.span>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// Bug report modal component
interface BugReportModalProps {
  isExpanded: boolean;
}

interface WindowWithErrors extends Window {
  __capturedErrors?: string[];
}

interface NavigatorWithExtras extends Navigator {
  deviceMemory?: number;
  hardwareConcurrency: number;
  connection?: {
    effectiveType?: string;
    downlink?: number;
    saveData?: boolean;
  };
}

interface PerformanceWithMemory extends Performance {
  memory?: {
    usedJSHeapSize: number;
    jsHeapSizeLimit: number;
  };
}

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
const MAX_SCREENSHOT_SIZE = 10 * 1024 * 1024; // 10MB

const bugReportLog = createLogger({ moduleName: 'bug-report-modal' });

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function sanitizeUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    const sensitiveParams = ['token', 'key', 'session', 'auth', 'reset', 'verify', 'code', 'state', 'apikey'];
    sensitiveParams.forEach(param => urlObj.searchParams.delete(param));
    return urlObj.toString();
  } catch {
    return url.split('?')[0];
  }
}

function sanitizeErrorMessage(error: string): string {
  // Redact potential API keys and tokens
  let sanitized = error.replace(/[a-f0-9]{32,}/gi, '[REDACTED_TOKEN]');
  sanitized = sanitized.replace(/sk-[A-Za-z0-9]{20,}/g, '[REDACTED_API_KEY]');
  sanitized = sanitized.replace(/Bearer\s+[A-Za-z0-9_-]+/gi, 'Bearer [REDACTED]');
  sanitized = sanitized.replace(/[Aa]pi[_-]?[Kk]ey[:\s]+[A-Za-z0-9_-]+/g, 'api_key: [REDACTED]');
  return escapeHtml(sanitized);
}

function validateScreenshotFile(file: File): string | null {
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    return 'Only JPEG, PNG, GIF, and WebP images are supported';
  }
  if (file.size > MAX_SCREENSHOT_SIZE) {
    return 'Screenshot must be smaller than 10MB';
  }
  return null;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

function collectBugReportMetadata(userDescription: string, steps: string, consoleErrors: string[], isAuthenticated: boolean): string {
  const sections: string[] = [];

  // User description - escape HTML
  sections.push('<strong>=== USER DESCRIPTION ===</strong>');
  sections.push(escapeHtml(userDescription));
  if (steps) {
    sections.push('<br><strong>Steps to Reproduce:</strong>');
    sections.push(escapeHtml(steps));
  }

  // Browser & System - escape all user-controlled data
  sections.push('<br><br><strong>=== BROWSER & SYSTEM INFO ===</strong>');
  if (typeof window !== 'undefined') {
    sections.push(`Page URL: ${escapeHtml(sanitizeUrl(window.location.href))}`);
    sections.push(`Page Title: ${escapeHtml(document.title)}`);
    sections.push(`Referrer: ${escapeHtml(document.referrer || 'Direct access')}`);
  }
  if (typeof navigator !== 'undefined') {
    sections.push(`Browser: ${escapeHtml(navigator.userAgent)}`);
    sections.push(`Platform: ${escapeHtml(navigator.platform)}`);
    sections.push(`Language: ${navigator.language}`);
    sections.push(`Online Status: ${navigator.onLine ? 'Online' : 'Offline'}`);
    sections.push(`Cookies Enabled: ${navigator.cookieEnabled}`);
    const nav = navigator as unknown as NavigatorWithExtras;
    if (nav.deviceMemory) {
      sections.push(`Device Memory: ${nav.deviceMemory} GB`);
    }
    if (nav.hardwareConcurrency) {
      sections.push(`CPU Cores: ${nav.hardwareConcurrency}`);
    }
  }

  // Display
  sections.push('<br><br><strong>=== DISPLAY INFO ===</strong>');
  if (typeof window !== 'undefined') {
    sections.push(`Screen Resolution: ${window.screen.width}x${window.screen.height}`);
    sections.push(`Viewport Size: ${window.innerWidth}x${window.innerHeight}`);
    sections.push(`Color Depth: ${window.screen.colorDepth}-bit`);
    sections.push(`Pixel Ratio: ${window.devicePixelRatio}`);
  }

  // Session - use isAuthenticated param instead of localStorage
  sections.push('<br><br><strong>=== SESSION INFO ===</strong>');
  sections.push(`Timestamp: ${new Date().toISOString()}`);
  sections.push(`Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  sections.push(`Authenticated: ${isAuthenticated ? 'Yes' : 'No'}`);
  if (typeof window !== 'undefined' && window.localStorage) {
    sections.push(`Local Storage Items: ${window.localStorage.length}`);
  }

  // Performance
  sections.push('<br><br><strong>=== PERFORMANCE METRICS ===</strong>');
  if (typeof window !== 'undefined' && window.performance) {
    const perf = window.performance as PerformanceWithMemory;
    if (perf.memory) {
      sections.push(`JS Heap Used: ${Math.round(perf.memory.usedJSHeapSize / 1048576)} MB`);
      sections.push(`JS Heap Limit: ${Math.round(perf.memory.jsHeapSizeLimit / 1048576)} MB`);
    } else {
      sections.push('Memory info not available');
    }
  }

  // Network
  if (typeof navigator !== 'undefined') {
    const navConn = navigator as unknown as NavigatorWithExtras;
    if (navConn.connection) {
      sections.push('<br><br><strong>=== NETWORK INFO ===</strong>');
      sections.push(`Connection Type: ${navConn.connection.effectiveType || 'Unknown'}`);
      if (navConn.connection.downlink) {
        sections.push(`Downlink Speed: ${navConn.connection.downlink} Mbps`);
      }
      sections.push(`Data Saver: ${navConn.connection.saveData ? 'Enabled' : 'Disabled'}`);
    }
  }

  // Console errors - sanitize and escape
  if (consoleErrors.length > 0) {
    sections.push('<br><br><strong>=== RECENT CONSOLE ERRORS ===</strong>');
    consoleErrors.slice(0, 10).forEach((err, index) => {
      sections.push(`Error ${index + 1}: ${sanitizeErrorMessage(err)}`);
    });
  }

  return sections.join('<br>');
}

function BugReportModal({ isExpanded }: BugReportModalProps) {
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [screenshotPreview, setScreenshotPreview] = useState<string | null>(null);
  const [consoleErrors, setConsoleErrors] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Capture console errors when the modal opens
  useEffect(() => {
    if (open) {
      const storedErrors = (window as unknown as WindowWithErrors).__capturedErrors || [];
      setConsoleErrors(storedErrors.slice(-10));
    }
  }, [open]);

  const setScreenshotFromFile = useCallback(async (file: File) => {
    const error = validateScreenshotFile(file);
    if (error) {
      toast.error(error);
      return;
    }
    setScreenshot(file);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setScreenshotPreview(dataUrl);
    } catch {
      toast.error('Failed to read screenshot file');
      setScreenshot(null);
    }
  }, []);

  const handleScreenshotChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setScreenshotFromFile(file);
  }, [setScreenshotFromFile]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          setScreenshotFromFile(file);
          break;
        }
      }
    }
  }, [setScreenshotFromFile]);

  const removeScreenshot = useCallback(() => {
    setScreenshot(null);
    setScreenshotPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      const form = e.currentTarget;
      const titleEl = form.elements.namedItem('title');
      const descriptionEl = form.elements.namedItem('description');
      const stepsEl = form.elements.namedItem('steps');

      if (!(titleEl instanceof HTMLInputElement) || !(descriptionEl instanceof HTMLTextAreaElement)) {
        toast.error('Form error. Please try again.');
        return;
      }

      const title = titleEl.value;
      const descriptionText = descriptionEl.value;
      const steps = stepsEl instanceof HTMLTextAreaElement ? stepsEl.value : '';

      // Build rich description with all metadata
      const fullDescription = collectBugReportMetadata(descriptionText, steps, consoleErrors, !!session);

      const formData = new FormData();
      formData.append('title', title);
      formData.append('description', fullDescription);

      // Convert screenshot to base64 data URL to avoid Next.js RSC serialization issues
      if (screenshot) {
        const dataUrl = screenshotPreview || await readFileAsDataUrl(screenshot);
        formData.append('screenshotData', dataUrl);
        formData.append('screenshotName', screenshot.name || 'screenshot.png');
        formData.append('screenshotType', screenshot.type);
      }

      const result = await createFreshserviceTicketAction(formData);

      if (result.isSuccess) {
        toast.success('Bug report submitted successfully');
        form.reset();
        setScreenshot(null);
        setScreenshotPreview(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
        handleOpenChange(false);
      } else {
        toast.error(result.message);
      }
    } catch (error) {
      bugReportLog.error('Bug report submission failed', { error: error instanceof Error ? error.message : String(error) });
      toast.error('An unexpected error occurred. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOpenChange = useCallback((newOpen: boolean) => {
    setOpen(newOpen);
    if (!newOpen) {
      setScreenshot(null);
      setScreenshotPreview(null);
    }
  }, []);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <div>
          <SidebarButton icon={Bug} label="Report a Bug" isExpanded={isExpanded} />
        </div>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Report a Bug</DialogTitle>
          <DialogDescription>
            Found an issue? Let us know so we can fix it.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} onPaste={handlePaste} className="space-y-4 pt-4">
          <div className="space-y-2">
            <Label htmlFor="bug-title">Title</Label>
            <Input
              id="bug-title"
              name="title"
              placeholder="Brief description of the issue"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bug-description">Description</Label>
            <Textarea
              id="bug-description"
              name="description"
              placeholder="What happened? What did you expect to happen?"
              rows={4}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bug-steps">Steps to Reproduce (optional)</Label>
            <Textarea
              id="bug-steps"
              name="steps"
              placeholder="1. Go to...&#10;2. Click on...&#10;3. See error"
              rows={3}
            />
          </div>
          <div className="space-y-2">
            <Label>Screenshot (optional)</Label>
            {screenshotPreview ? (
              <div className="relative inline-block">
                <img
                  src={screenshotPreview}
                  alt="Screenshot preview"
                  className="max-h-32 rounded-md border"
                />
                <Button
                  type="button"
                  variant="destructive"
                  size="icon"
                  className="absolute -top-2 -right-2 h-6 w-6"
                  onClick={removeScreenshot}
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <Label
                    htmlFor="bug-screenshot"
                    className="flex items-center gap-2 px-4 py-2 border rounded-md cursor-pointer hover:bg-muted transition-colors"
                  >
                    <ImageIcon className="h-4 w-4" />
                    <span className="text-sm">Attach Screenshot</span>
                  </Label>
                  <Input
                    ref={fileInputRef}
                    id="bug-screenshot"
                    type="file"
                    accept=".jpg,.jpeg,.png,.gif,.webp"
                    className="hidden"
                    onChange={handleScreenshotChange}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Tip: You can also paste images directly (Ctrl/Cmd+V)
                </p>
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Submitting...' : 'Submit Report'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// User profile component for sidebar
interface SidebarUserProfileProps {
  isExpanded: boolean;
  fullName: string;
  userInitials: string;
  email?: string | null;
  image?: string | null;
}

function SidebarUserProfile({ isExpanded, fullName, userInitials, email, image }: SidebarUserProfileProps) {
  return (
    <div className={cn('flex items-center gap-3 p-2 rounded-lg bg-muted/50', !isExpanded && 'justify-center')}>
      <Avatar className="h-8 w-8 flex-shrink-0">
        <AvatarImage src={image || undefined} />
        <AvatarFallback className="bg-[#1B365D] text-white text-xs font-medium">{userInitials}</AvatarFallback>
      </Avatar>
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            variants={labelVariants}
            initial="collapsed"
            animate="expanded"
            exit="collapsed"
            className="flex-1 min-w-0 overflow-hidden"
          >
            <p className="text-sm font-medium truncate">{fullName}</p>
            <p className="text-xs text-muted-foreground truncate">{email}</p>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {isExpanded && (
          <motion.div variants={labelVariants} initial="collapsed" animate="expanded" exit="collapsed">
            <Link href="/signout">
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <LogOut className="h-4 w-4" />
              </Button>
            </Link>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Process navigation items into proper structure
function processNavigationItems(navItems: NavigationItem[]): ProcessedItem[] {
  if (navItems.length === 0) return [];

  const topLevelItems = navItems.filter((item) => item.parent_id === null);

  const processed = topLevelItems.map((section) => {
    const children = navItems.filter((item) => item.parent_id === section.id);
    const processedSection: ProcessedItem = {
      id: section.id,
      label: section.label,
      icon: section.icon as IconName,
      type: section.type,
      color: section.color,
    };

    if (section.type === 'page') {
      processedSection.link = section.link || `/page/${section.id}`;
    } else if (section.link) {
      processedSection.link = section.link;
    }

    if (children.length > 0) {
      processedSection.links = children.map((child) => ({
        label: child.label,
        link: child.type === 'page' ? child.link || `/page/${child.id}` : child.link || '#',
        description: child.description,
        icon: child.icon as IconName,
        color: child.color,
      }));
    }

    return processedSection;
  });

  processed.sort((a, b) => {
    const aItem = topLevelItems.find((item) => item.id === a.id);
    const bItem = topLevelItems.find((item) => item.id === b.id);
    return (aItem?.position || 0) - (bItem?.position || 0);
  });

  return processed;
}

function NavigationContent({ isExpanded }: { isExpanded: boolean }) {
  const { data: session } = useSession();
  const [navItems, setNavItems] = useState<NavigationItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const { fullName, userInitials } = useMemo(() => {
    const givenName = session?.user?.givenName || session?.user?.name?.split(' ')[0] || 'User';
    const familyName = session?.user?.familyName || '';
    const displayName = familyName ? `${givenName} ${familyName}` : givenName;
    return { fullName: displayName, userInitials: givenName.charAt(0).toUpperCase() };
  }, [session?.user?.givenName, session?.user?.name, session?.user?.familyName]);

  const processedItems = useMemo(() => processNavigationItems(navItems), [navItems]);

  useEffect(() => {
    const fetchNavigation = async () => {
      try {
        setIsLoading(true);
        const response = await fetch('/api/navigation');
        const data = await response.json();
        setNavItems(data.isSuccess && Array.isArray(data.data) ? data.data : []);
      } catch {
        setNavItems([]);
      } finally {
        setIsLoading(false);
      }
    };
    fetchNavigation();
  }, []);

  return (
    <>
      {/* Sidebar Logo */}
      <div className={cn('flex items-center justify-center py-2 border-b border-border/40', isExpanded ? 'px-3' : 'px-2')}>
        <Link
          href="/dashboard"
          className={cn(
            'flex items-center justify-center transition-all duration-200',
            isExpanded ? 'w-full h-10 gap-2' : 'w-10 h-10'
          )}
        >
          <Image
            src="/logo.png"
            alt="Peninsula School District"
            width={isExpanded ? 28 : 24}
            height={isExpanded ? 28 : 24}
            className="object-contain"
          />
          {isExpanded && <span className="text-[#1B365D] text-base font-bold">PSD AI Studio</span>}
        </Link>
      </div>

      {/* Navigation Links */}
      <div className="flex-1 flex flex-col">
        <ScrollArea className="flex-1">
          <div className={cn('py-4', isExpanded ? 'px-3' : 'px-2')}>
            {isLoading ? (
              <div className="text-center py-4">Loading...</div>
            ) : (
              <div className="space-y-2">
                {processedItems.map((item) => (
                  <LinksGroup
                    key={item.id}
                    isExpanded={isExpanded}
                    {...item}
                    icon={iconMap[item.icon] || iconMap.IconHome}
                  />
                ))}
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Bottom Section */}
        <div className={cn('border-t border-border/40 py-3', isExpanded ? 'px-3' : 'px-2')}>
          <SidebarNotifications isExpanded={isExpanded} />
          <SidebarMessages isExpanded={isExpanded} />
          <BugReportModal isExpanded={isExpanded} />
          <SidebarLink href="/settings" icon={Settings} label="Settings" isExpanded={isExpanded} />
          {session && (
            <SidebarUserProfile
              isExpanded={isExpanded}
              fullName={fullName}
              userInitials={userInitials}
              email={session.user?.email}
              image={session.user?.image}
            />
          )}
        </div>
      </div>
    </>
  );
}
