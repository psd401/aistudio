"use client";

import { useMessagePart } from "@assistant-ui/react";
import type { SyntaxHighlighterProps } from "@assistant-ui/react-markdown";
import mermaid from "mermaid";
import { FC, useEffect, useRef, useId, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Props for the MermaidDiagram component
 */
export type MermaidDiagramProps = SyntaxHighlighterProps & {
  className?: string;
};

// Initialize mermaid once at module level
mermaid.initialize({ theme: "default", startOnLoad: false });

/**
 * MermaidDiagram component for rendering Mermaid diagrams
 * Use it by passing to `componentsByLanguage` for mermaid in `markdown-text.tsx`
 *
 * @example
 * const MarkdownTextImpl = () => {
 *   return (
 *     <MarkdownTextPrimitive
 *       remarkPlugins={[remarkGfm]}
 *       className="aui-md"
 *       components={defaultComponents}
 *       componentsByLanguage={{
 *         mermaid: {
 *           SyntaxHighlighter: MermaidDiagram
 *         },
 *       }}
 *     />
 *   );
 * };
 */
export const MermaidDiagram: FC<MermaidDiagramProps> = ({
  code,
  className,
}) => {
  const ref = useRef<HTMLPreElement>(null);
  const diagramId = useId();
  const [theme, setTheme] = useState<'default' | 'dark'>('default');

  // Smart completion detection for streaming scenarios
  const isComplete = useMessagePart((part) => {
    if (part.type !== "text") return false;

    const codeIndex = part.text.indexOf(code);
    if (codeIndex === -1) return false;

    const afterCode = part.text.substring(codeIndex + code.length);

    // Check if closing backticks appear after the code
    const closingBackticksMatch = afterCode.match(/^```|^\n```/);
    return closingBackticksMatch !== null;
  });

  // Observe theme changes
  useEffect(() => {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
          const isDark = document.documentElement.classList.contains('dark');
          setTheme(isDark ? 'dark' : 'default');
        }
      }
    });

    // Set initial theme
    const isDark = document.documentElement.classList.contains('dark');
    setTheme(isDark ? 'dark' : 'default');

    // Start observing
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class']
    });

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    // Only render when the code block is complete
    if (!isComplete) return;

    (async () => {
      try {
        // Re-initialize mermaid with current theme
        mermaid.initialize({ theme, startOnLoad: false });
        
        const id = `mermaid-${diagramId.replace(/:/g, '')}`;
        const result = await mermaid.render(id, code);
        
        if (ref.current) {
          ref.current.innerHTML = result.svg;
          result.bindFunctions?.(ref.current);
        }
      } catch {
        // Silently fail - diagram won't render but app continues
        // Mermaid will handle invalid syntax gracefully by not rendering
        // No logging needed as this is expected behavior for invalid diagrams
      }
    })();
  }, [isComplete, code, theme, diagramId]);

  return (
    <pre ref={ref} className={cn("bg-muted rounded-b-lg p-2 text-center [&_svg]:mx-auto", className)} />
  );
};

MermaidDiagram.displayName = "MermaidDiagram";