import { useState } from "react";
import { ActionState } from "@/types/actions-types";
import { toast } from "@/components/ui/use-toast";
import { createLogger } from "@/lib/client-logger";

type ActionFunction<TInput, TOutput> = (data: TInput) => Promise<ActionState<TOutput>>;

interface UseActionOptions<TOutput> {
  onSuccess?: (data: TOutput) => void;
  onError?: (message: string) => void;
  onSettled?: () => void;
  showSuccessToast?: boolean;
  showErrorToast?: boolean;
  successMessage?: string;
}

const log = createLogger({ hook: "useAction" });

/**
 * Hook for handling server actions with loading state and toast notifications
 */
export function useAction<TInput, TOutput>(
  action: ActionFunction<TInput, TOutput>,
  options: UseActionOptions<TOutput> = {}
) {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<TOutput | null>(null);

  const {
    onSuccess,
    onError,
    onSettled,
    showSuccessToast = true,
    showErrorToast = true,
    successMessage,
  } = options;

  const execute = async (input: TInput): Promise<ActionState<TOutput>> => {
    setIsPending(true);
    setError(null);

    try {
      const result = await action(input);

      if (result.isSuccess) {
        setData(result.data);
        
        if (showSuccessToast) {
          toast({
            title: "Success",
            description: successMessage || result.message,
            variant: "default",
          });
        }

        onSuccess?.(result.data);
        return result;
      } else {
        setError(result.message);
        
        if (showErrorToast) {
          toast({
            title: "Error",
            description: result.message,
            variant: "destructive",
          });
        }

        onError?.(result.message);
        return result;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "An unexpected error occurred";

      // Detect stale server action references after deployment
      // Next.js throws this when the client has cached action IDs from a previous build
      // Use instanceof + startsWith (not includes) to avoid matching ActionState message strings
      // Error message validated against Next.js 16.x — if detection silently breaks after an
      // upgrade, check server logs for unhandled "Failed to find Server Action" errors.
      if (e instanceof Error && e.message.startsWith("Failed to find Server Action")) {
        const staleMessage = "Application updated, reloading...";
        // Set internal error state but don't invoke onError — the page reloads in 1.5s
        // and calling onError would cause callers to briefly flash error UI before reload.
        log.warn("Stale server action detected — triggering reload", { message: e.message });
        setError(staleMessage);
        toast({
          title: "New version available",
          description: "The application has been updated. Reloading...",
          variant: "default",
        });
        // Brief delay so the toast is visible before reload.
        // Intentionally fire-and-forget — the reload is expected to always happen.
        // typeof guard is idiomatic in Next.js hooks (SSR safety, avoids build warnings).
        setTimeout(() => typeof window !== 'undefined' && window.location.reload(), 1500);
        return {
          isSuccess: false,
          message: staleMessage,
        };
      }

      setError(message);

      if (showErrorToast) {
        toast({
          title: "Error",
          description: message,
          variant: "destructive",
        });
      }

      onError?.(message);
      return {
        isSuccess: false,
        message,
      };
    } finally {
      setIsPending(false);
      onSettled?.();
    }
  };

  return {
    execute,
    isPending,
    error,
    data,
    reset: () => {
      setError(null);
      setData(null);
    },
  };
}