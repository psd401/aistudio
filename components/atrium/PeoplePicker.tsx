"use client";

/**
 * Atrium PeoplePicker — search-by-name/email control for `user` visibility
 * grants (#1336 C5).
 *
 * Replaces the raw "Numeric user ID" text input in the visibility editor's grant
 * builder. A `user` grant stores a numeric `users.id`, which is the right thing
 * to persist and an impossible thing to type: nobody knows a colleague's row id,
 * so per-person sharing was effectively unreachable even though the whole grant
 * machinery worked.
 *
 * The picker searches, the caller receives `{ id, label }` and stores the id.
 * Authorization is entirely server-side (`searchPeopleAction` is capability-
 * gated and caps its result set); this component renders what it returns.
 */

import { useEffect, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  searchPeopleAction,
  type PersonOption,
} from "@/actions/db/atrium/search-people";
import { createLogger } from "@/lib/client-logger";

const log = createLogger({ component: "PeoplePicker" });

/** Debounce before a keystroke reaches the server. */
const SEARCH_DEBOUNCE_MS = 300;

export function PeoplePicker({
  disabled,
  onSelect,
}: {
  disabled?: boolean;
  /** A person was chosen — the caller stores `id` as the grant value. */
  onSelect: (person: PersonOption) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PersonOption[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      void (async () => {
        try {
          const res = await searchPeopleAction(term);
          if (cancelled) return;
          if (res.isSuccess) setResults(res.data);
          else {
            setResults([]);
            log.warn("searchPeopleAction failed", { message: res.message });
          }
        } catch (e) {
          if (cancelled) return;
          setResults([]);
          log.error("searchPeopleAction threw", {
            error: e instanceof Error ? e.message : String(e),
          });
        } finally {
          if (!cancelled) setSearching(false);
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
      // Leave `searching` as-is on cancel: the next effect run sets it again,
      // and clearing it here would flicker the spinner between keystrokes.
    };
  }, [query]);

  return (
    <div className="space-y-1.5">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          id="grant-value"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search people by name or email"
          aria-label="Search people by name or email"
          disabled={disabled}
          className="pl-7"
          data-testid="people-picker-input"
        />
      </div>

      {searching && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          Searching…
        </p>
      )}

      {!searching && query.trim().length >= 2 && results.length === 0 && (
        <p className="text-xs text-muted-foreground">No matching people.</p>
      )}

      {results.length > 0 && (
        <ul
          className="max-h-44 overflow-y-auto rounded-md border border-input"
          data-testid="people-picker-results"
        >
          {results.map((person) => (
            <li key={person.id}>
              <button
                type="button"
                className="flex w-full flex-col items-start px-2 py-1.5 text-left text-sm hover:bg-accent"
                disabled={disabled}
                onClick={() => {
                  onSelect(person);
                  setQuery("");
                  setResults([]);
                }}
                data-testid={`people-picker-option-${person.id}`}
              >
                <span className="font-medium">{person.name}</span>
                <span className="text-xs text-muted-foreground">
                  {person.email}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
