import { useState } from "react";
import { ActionState } from "@/types/actions-types";
import { toast } from "@/components/ui/use-toast";

type ActionFunction<TInput, TOutput> = (data: TInput) => Promise<ActionState<TOutput>>;

interface UseActionOptions<TOutput> {
  onSuccess?: (data: TOutput) => void;
  onError?: (message: string) => void;
  onSettled?: () => void;
  showSuccessToast?: boolean;
  showErrorToast?: boolean;
  successMessage?: string;
}

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
      if (e instanceof Error && e.message.startsWith("Failed to find Server Action")) {
        toast({
          title: "New version available",
          description: "The application has been updated. Reloading...",
          variant: "default",
        });
        // Brief delay so the toast is visible before reload.
        // Intentionally fire-and-forget — the reload is expected to always happen.
        setTimeout(() => window.location.reload(), 1500);
        return {
          isSuccess: false,
          message: "Application updated, reloading...",
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