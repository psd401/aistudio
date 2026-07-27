"use client";

import { Search, UserPlus, X } from "lucide-react";
import type { RosterStudentOption } from "@/lib/rooms/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface RoomStudentPickerProps {
  search: string;
  results: RosterStudentOption[];
  memberEmails: string[];
  isSearching: boolean;
  onSearchChange: (value: string) => void;
  onSearch: () => void;
  onAdd: (student: RosterStudentOption) => void;
  onRemove: (email: string) => void;
}

export function RoomStudentPicker({
  search,
  results,
  memberEmails,
  isSearching,
  onSearchChange,
  onSearch,
  onAdd,
  onRemove,
}: RoomStudentPickerProps) {
  return (
    <fieldset className="space-y-3">
      <legend className="font-medium">Individual students</legend>
      <p className="text-xs text-muted-foreground">
        Search the active roster. Explicit members are unioned with section
        enrollment.
      </p>
      <div className="flex gap-2">
        <Input
          value={search}
          data-testid="room-student-search"
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Name or email"
          minLength={2}
        />
        <Button
          type="button"
          variant="outline"
          disabled={isSearching || search.trim().length < 2}
          onClick={onSearch}
          data-testid="room-student-search-button"
        >
          <Search className="mr-2 h-4 w-4" />
          Search
        </Button>
      </div>
      {results.length > 0 && (
        <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
          {results.map((student) => (
            <button
              key={student.email}
              type="button"
              className="flex w-full items-center justify-between rounded p-2 text-left text-sm hover:bg-muted"
              onClick={() => onAdd(student)}
              data-testid={`room-student-result-${student.email}`}
            >
              <span>
                {[student.givenName, student.familyName]
                  .filter(Boolean)
                  .join(" ") || student.email}
                <span className="ml-2 text-xs text-muted-foreground">
                  {student.email}
                </span>
              </span>
              <UserPlus className="h-4 w-4" />
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2" data-testid="room-explicit-members">
        {memberEmails.map((email) => (
          <Badge key={email} variant="secondary">
            {email}
            <button
              type="button"
              className="ml-1"
              aria-label={`Remove ${email}`}
              onClick={() => onRemove(email)}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
      </div>
    </fieldset>
  );
}
