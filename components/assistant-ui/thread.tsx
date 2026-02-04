import {
  ThreadPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ActionBarPrimitive,
  BranchPickerPrimitive,
  ErrorPrimitive,
  useMessage,
} from "@assistant-ui/react";
import type { FC } from "react";
import { createContext, useContext, useMemo } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CopyIcon,
  CheckIcon,
  PencilIcon,
  RefreshCwIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Square,
  Volume2Icon,
  VolumeOffIcon,
} from "lucide-react";

import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MarkdownText } from "./markdown-text";
import { WebSearchSource } from "./web-search-sources";
import { ToolFallback } from "./tool-fallback";
import { ToolGroup } from "@/app/(protected)/nexus/_components/tools/tool-group";
import {
  ComposerAttachments,
  ComposerAddAttachment,
  UserMessageAttachments,
} from "@/components/assistant-ui/attachment";
import { PromptSaveButton } from "@/app/(protected)/nexus/_components/chat/prompt-save-button";
import { ComposerControls } from "@/app/(protected)/nexus/_components/chat/composer-controls";
import type { SelectAiModel } from "@/types";

// Context for passing conversationId to message components
const ConversationIdContext = createContext<string | null>(null);

export const useConversationId = () => useContext(ConversationIdContext);

// Pre-defined constants to avoid creating new objects/arrays on every render
const EMPTY_MODELS_ARRAY: SelectAiModel[] = [];
const EMPTY_TOOLS_ARRAY: string[] = [];

const THREAD_ROOT_STYLE = {
  ["--thread-max-width" as string]: "48rem",
  ["--thread-padding-x" as string]: "1rem",
};

const ASSISTANT_MESSAGE_CONTENT_COMPONENTS = {
  Text: MarkdownText,
  Source: WebSearchSource,
  ToolGroup: ToolGroup,
  tools: { Fallback: ToolFallback },
};

const USER_MESSAGE_CONTENT_COMPONENTS = { Text: MarkdownText };

const MOTION_FADE_IN = { y: 5, opacity: 0 };
const MOTION_VISIBLE = { y: 0, opacity: 1 };

const SUGGESTION_MOTION_INITIAL = { opacity: 0, y: 20 };
const SUGGESTION_MOTION_ANIMATE = { opacity: 1, y: 0 };
const SUGGESTION_MOTION_EXIT = { opacity: 0, y: 20 };

const SUGGESTED_ACTIONS = [
  {
    title: "Help me create a lesson plan",
    label: "for 5th grade math fractions",
    action: "Help me create a lesson plan for 5th grade math fractions",
  },
  {
    title: "Write a parent communication",
    label: "email about upcoming field trip",
    action: "Write a parent communication email about upcoming field trip",
  },
  {
    title: "Generate discussion questions",
    label: "for high school literature class",
    action: "Generate discussion questions for high school literature class",
  },
  {
    title: "Create a rubric",
    label: "for evaluating student presentations",
    action: "Create a rubric for evaluating student presentations",
  },
];

export interface SuggestedAction {
  title: string;
  label: string;
  action: string;
}

interface ThreadProps {
  processingAttachments?: Set<string>;
  conversationId?: string | null;
  // Model and tools for composer controls
  models?: SelectAiModel[];
  selectedModel?: SelectAiModel | null;
  onModelChange?: (model: SelectAiModel) => void;
  isLoadingModels?: boolean;
  enabledTools?: string[];
  onToolsChange?: (tools: string[]) => void;
  // Custom suggested actions (pass [] to hide, undefined for defaults)
  suggestedActions?: SuggestedAction[];
}

export const Thread: FC<ThreadProps> = ({
  processingAttachments,
  conversationId,
  models = EMPTY_MODELS_ARRAY,
  selectedModel,
  onModelChange,
  isLoadingModels = false,
  enabledTools = EMPTY_TOOLS_ARRAY,
  onToolsChange,
  suggestedActions,
}) => {
  // Memoize message components to avoid recreation on every render
  const messageComponents = useMemo(() => ({
    UserMessage,
    EditComposer,
    AssistantMessage,
  }), []);

  return (
    <ConversationIdContext.Provider value={conversationId || null}>
      <ThreadPrimitive.Root
        className="bg-white flex h-full flex-col"
        style={THREAD_ROOT_STYLE}
      >
        <ThreadPrimitive.Viewport className="relative flex min-w-0 flex-1 h-0 flex-col gap-6 overflow-y-auto">
          <ThreadWelcome conversationId={conversationId} />

          <ThreadPrimitive.Messages
            components={messageComponents}
          />

          <ThreadPrimitive.If empty={false}>
            <motion.div className="min-h-6 min-w-6 shrink-0" />
          </ThreadPrimitive.If>
        </ThreadPrimitive.Viewport>

        <Composer
          processingAttachments={processingAttachments}
          models={models}
          selectedModel={selectedModel}
          onModelChange={onModelChange}
          isLoadingModels={isLoadingModels}
          enabledTools={enabledTools}
          onToolsChange={onToolsChange}
          suggestedActions={suggestedActions}
        />
      </ThreadPrimitive.Root>
    </ConversationIdContext.Provider>
  );
};

const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="Scroll to bottom"
        variant="outline"
        className="dark:bg-background dark:hover:bg-accent absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible"
      >
        <ArrowDownIcon />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

const ThreadWelcome: FC<{ conversationId?: string | null }> = ({ conversationId }) => {
  // If we have a conversationId (loading existing conversation), show loading state
  if (conversationId) {
    return (
      <ThreadPrimitive.Empty>
        <div className="mx-auto flex w-full max-w-[var(--thread-max-width)] flex-grow flex-col px-[var(--thread-padding-x)]">
          <div className="flex w-full flex-grow flex-col items-center justify-center">
            <div className="flex items-center space-x-2">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
              <span className="text-muted-foreground">Loading conversation...</span>
            </div>
          </div>
        </div>
      </ThreadPrimitive.Empty>
    );
  }

  // For new conversations, we just show empty space
  // The greeting is now in the input placeholder
  return null;
};

// Extracted component to avoid inline transition object in map
interface SuggestionItemProps {
  suggestion: typeof SUGGESTED_ACTIONS[number];
  index: number;
}

const SuggestionItem: FC<SuggestionItemProps> = ({ suggestion, index }) => {
  const transition = useMemo(() => ({ delay: 0.05 * index }), [index]);

  return (
    <motion.div
      initial={SUGGESTION_MOTION_INITIAL}
      animate={SUGGESTION_MOTION_ANIMATE}
      exit={SUGGESTION_MOTION_EXIT}
      transition={transition}
      className="[&:nth-child(n+3)]:hidden sm:[&:nth-child(n+3)]:block"
    >
      <ThreadPrimitive.Suggestion
        prompt={suggestion.action}
        method="replace"
        autoSend
        asChild
      >
        <Button
          variant="ghost"
          className="dark:hover:bg-accent/60 h-auto w-full flex-1 flex-wrap items-start justify-start gap-1 rounded-xl border px-4 py-3.5 text-left text-sm sm:flex-col"
          aria-label={suggestion.action}
        >
          <span className="font-medium">
            {suggestion.title}
          </span>
          <p className="text-muted-foreground">
            {suggestion.label}
          </p>
        </Button>
      </ThreadPrimitive.Suggestion>
    </motion.div>
  );
};

const ThreadWelcomeSuggestions: FC<{ actions?: SuggestedAction[] }> = ({ actions }) => {
  const items = actions ?? SUGGESTED_ACTIONS;
  if (items.length === 0) return null;

  return (
    <div className="grid w-full gap-2 sm:grid-cols-2">
      {items.map((suggestedAction, index) => (
        <SuggestionItem
          key={`suggested-action-${suggestedAction.title}-${index}`}
          suggestion={suggestedAction}
          index={index}
        />
      ))}
    </div>
  );
};

interface ComposerProps {
  processingAttachments?: Set<string>;
  models?: SelectAiModel[];
  selectedModel?: SelectAiModel | null;
  onModelChange?: (model: SelectAiModel) => void;
  isLoadingModels?: boolean;
  enabledTools?: string[];
  onToolsChange?: (tools: string[]) => void;
  suggestedActions?: SuggestedAction[];
}

const Composer: FC<ComposerProps> = ({
  processingAttachments,
  models = EMPTY_MODELS_ARRAY,
  selectedModel,
  onModelChange,
  isLoadingModels = false,
  enabledTools = EMPTY_TOOLS_ARRAY,
  onToolsChange,
  suggestedActions,
}) => {
  return (
    <div className="bg-white relative mx-auto flex w-full max-w-[var(--thread-max-width)] flex-col gap-4 px-[var(--thread-padding-x)] pb-4 md:pb-6">
      <ThreadScrollToBottom />
      <ThreadPrimitive.Empty>
        <ThreadWelcomeSuggestions actions={suggestedActions} />
      </ThreadPrimitive.Empty>
      <ComposerPrimitive.Root className="relative flex w-full flex-col rounded-2xl border border-border focus-within:ring-2 focus-within:ring-black focus-within:ring-offset-2 dark:focus-within:ring-white overflow-hidden">
        {/* Control dock for model, tools, skills, MCP */}
        {onModelChange && onToolsChange && (
          <ComposerControls
            models={models}
            selectedModel={selectedModel ?? null}
            onModelChange={onModelChange}
            isLoadingModels={isLoadingModels}
            enabledTools={enabledTools}
            onToolsChange={onToolsChange}
          />
        )}
        <ComposerAttachments processingAttachments={processingAttachments} />
        <ComposerPrimitive.Input
          placeholder="How can I help you today?"
          className="bg-muted dark:border-muted-foreground/15 focus:outline-primary placeholder:text-muted-foreground max-h-[calc(50dvh)] min-h-16 w-full resize-none px-4 pb-3 pt-2 text-base outline-none"
          rows={1}
          // eslint-disable-next-line jsx-a11y/no-autofocus -- Intentional: message input is primary interaction
          autoFocus
          aria-label="Message input"
        />
        <ComposerAction processingAttachments={processingAttachments} />
      </ComposerPrimitive.Root>
    </div>
  );
};

interface ComposerActionProps {
  processingAttachments?: Set<string>;
}

const ComposerAction: FC<ComposerActionProps> = ({ processingAttachments }) => {
  const hasProcessingAttachments = processingAttachments && processingAttachments.size > 0;
  
  return (
    <div className="bg-muted border-border dark:border-muted-foreground/15 relative flex items-center justify-between rounded-b-2xl border-x border-b p-2">
      <ComposerAddAttachment />

      <ThreadPrimitive.If running={false}>
        <ComposerPrimitive.Send asChild>
          <Button
            type="submit"
            variant="default"
            disabled={hasProcessingAttachments}
            className={cn(
              "size-8 rounded-full border",
              "dark:border-muted-foreground/90 border-muted-foreground/60 hover:bg-primary/75",
              hasProcessingAttachments && "opacity-50 cursor-not-allowed"
            )}
            aria-label={hasProcessingAttachments ? "Processing documents..." : "Send message"}
            title={hasProcessingAttachments ? "Please wait for document processing to complete" : "Send message"}
          >
            <ArrowUpIcon className="size-5" />
          </Button>
        </ComposerPrimitive.Send>
      </ThreadPrimitive.If>

      <ThreadPrimitive.If running>
        <ComposerPrimitive.Cancel asChild>
          <Button
            type="button"
            variant="default"
            className="dark:border-muted-foreground/90 border-muted-foreground/60 hover:bg-primary/75 size-8 rounded-full border"
            aria-label="Stop generating"
          >
            <Square className="size-3.5 fill-white dark:size-4 dark:fill-black" />
          </Button>
        </ComposerPrimitive.Cancel>
      </ThreadPrimitive.If>
    </div>
  );
};

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="border-destructive bg-destructive/10 dark:bg-destructive/5 text-destructive mt-2 rounded-md border p-3 text-sm dark:text-red-200">
        <ErrorPrimitive.Message className="line-clamp-2" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

const AssistantMessage: FC = () => {
  return (
    <MessagePrimitive.Root asChild>
      <motion.div
        className="relative mx-auto grid w-full max-w-[var(--thread-max-width)] grid-cols-[auto_auto_1fr] grid-rows-[auto_1fr] px-[var(--thread-padding-x)] py-4"
        initial={MOTION_FADE_IN}
        animate={MOTION_VISIBLE}
        data-role="assistant"
      >
        <div className="ring-border bg-background col-start-1 row-start-1 flex size-8 shrink-0 items-center justify-center rounded-full ring-1">
          <StarIcon size={14} />
        </div>

        <div className="text-foreground col-span-2 col-start-2 row-start-1 ml-4 break-words leading-7">
          <MessagePrimitive.Content
            components={ASSISTANT_MESSAGE_CONTENT_COMPONENTS}
          />
          <MessageError />
        </div>

        <AssistantActionBar />

        <BranchPicker className="col-start-2 row-start-2 -ml-2 mr-2" />
      </motion.div>
    </MessagePrimitive.Root>
  );
};

const AssistantActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      autohideFloat="single-branch"
      className="text-muted-foreground data-floating:bg-background data-floating:absolute data-floating:mt-2 data-floating:rounded-md data-floating:border data-floating:p-1 data-floating:shadow-sm col-start-3 row-start-2 ml-3 mt-3 flex gap-1"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="Copy">
          <MessagePrimitive.If copied>
            <CheckIcon />
          </MessagePrimitive.If>
          <MessagePrimitive.If copied={false}>
            <CopyIcon />
          </MessagePrimitive.If>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Speak asChild>
        <TooltipIconButton tooltip="Read aloud">
          <MessagePrimitive.If speaking>
            <VolumeOffIcon />
          </MessagePrimitive.If>
          <MessagePrimitive.If speaking={false}>
            <Volume2Icon />
          </MessagePrimitive.If>
        </TooltipIconButton>
      </ActionBarPrimitive.Speak>
      <ActionBarPrimitive.Reload asChild>
        <TooltipIconButton tooltip="Refresh">
          <RefreshCwIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Reload>
    </ActionBarPrimitive.Root>
  );
};

const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root asChild>
      <motion.div
        className="mx-auto grid w-full max-w-[var(--thread-max-width)] auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] gap-y-1 px-[var(--thread-padding-x)] py-4 [&:where(>*)]:col-start-2"
        initial={MOTION_FADE_IN}
        animate={MOTION_VISIBLE}
        data-role="user"
      >
        <UserActionBar />

        <UserMessageAttachments />

        <div className="bg-muted text-foreground col-start-2 break-words rounded-3xl px-5 py-2.5">
          <MessagePrimitive.Content components={USER_MESSAGE_CONTENT_COMPONENTS} />
        </div>

        <BranchPicker className="col-span-full col-start-1 row-start-3 -mr-1 justify-end" />
      </motion.div>
    </MessagePrimitive.Root>
  );
};

const UserActionBar: FC = () => {
  const message = useMessage();
  const conversationId = useConversationId();

  // Extract text content from message
  const messageContent = message.content
    .filter(part => part.type === "text")
    .map(part => (part as { type: "text"; text: string }).text)
    .join("\n");

  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="col-start-1 mr-3 mt-2.5 flex flex-col items-end gap-1"
    >
      <ActionBarPrimitive.Edit asChild>
        <TooltipIconButton tooltip="Edit">
          <PencilIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Edit>

      {messageContent && (
        <PromptSaveButton
          content={messageContent}
          conversationId={conversationId}
        />
      )}
    </ActionBarPrimitive.Root>
  );
};

const EditComposer: FC = () => {
  return (
    <div className="mx-auto flex w-full max-w-[var(--thread-max-width)] flex-col gap-4 px-[var(--thread-padding-x)]">
      <ComposerPrimitive.Root className="bg-muted max-w-7/8 ml-auto flex w-full flex-col rounded-xl">
        <ComposerPrimitive.Input
          className="text-foreground flex min-h-[60px] w-full resize-none bg-transparent p-4 outline-none"
          // eslint-disable-next-line jsx-a11y/no-autofocus -- Intentional: edit mode expects immediate focus
          autoFocus
        />

        <div className="mx-3 mb-3 flex items-center justify-center gap-2 self-end">
          <ComposerPrimitive.Cancel asChild>
            <Button variant="ghost" size="sm" aria-label="Cancel edit">
              Cancel
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button size="sm" aria-label="Update message">
              Update
            </Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </div>
  );
};

const BranchPicker: FC<BranchPickerPrimitive.Root.Props> = ({
  className,
  ...rest
}) => {
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn("text-muted-foreground inline-flex items-center text-xs", className)}
      {...rest}
    >
      <BranchPickerPrimitive.Previous asChild>
        <TooltipIconButton tooltip="Previous">
          <ChevronLeftIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Previous>
      <span className="font-medium">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <TooltipIconButton tooltip="Next">
          <ChevronRightIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};

const StarIcon = ({ size = 14 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M8 0L9.79611 6.20389L16 8L9.79611 9.79611L8 16L6.20389 9.79611L0 8L6.20389 6.20389L8 0Z"
      fill="currentColor"
    />
  </svg>
);
