'use client';

import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Badge } from '@/components/ui/badge';
import { ChevronDown } from 'lucide-react';

/** A selectable role option. `description` is optional (roles from the DB may not carry one). */
export interface RoleChoice {
  value: string;
  label: string;
  description?: string;
}

interface MultiRoleSelectorProps {
  userId: number | string;
  currentRoles: string[];
  /** Roles to choose from — fetched dynamically from the DB (getRoles), #1204. */
  availableRoles: RoleChoice[];
  onRolesChange: (userId: number | string, roles: string[]) => void;
  disabled?: boolean;
}

export function MultiRoleSelector({
  userId,
  currentRoles,
  availableRoles,
  onRolesChange,
  disabled = false,
}: MultiRoleSelectorProps) {
  const [selectedRoles, setSelectedRoles] = useState<string[]>(currentRoles);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    setSelectedRoles(currentRoles);
  }, [currentRoles]);

  const handleRoleToggle = (role: string) => {
    const newRoles = selectedRoles.includes(role)
      ? selectedRoles.filter(r => r !== role)
      : [...selectedRoles, role];
    setSelectedRoles(newRoles);
  };

  const handleSave = () => {
    onRolesChange(userId, selectedRoles);
    setIsOpen(false);
  };

  const handleCancel = () => {
    setSelectedRoles(currentRoles);
    setIsOpen(false);
  };

  // Ensure at least one role is always selected
  const isValid = selectedRoles.length > 0;

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          disabled={disabled}
          className="w-[200px] justify-between"
        >
          <div className="flex gap-1 overflow-hidden">
            {currentRoles.length === 0 ? (
              <span className="text-muted-foreground">No roles</span>
            ) : currentRoles.length === 1 ? (
              <span>{currentRoles[0]}</span>
            ) : (
              <>
                <Badge variant="secondary" className="text-xs">
                  {currentRoles[0]}
                </Badge>
                {currentRoles.length > 1 && (
                  <Badge variant="secondary" className="text-xs">
                    +{currentRoles.length - 1}
                  </Badge>
                )}
              </>
            )}
          </div>
          <ChevronDown className="h-4 w-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-4">
        <div className="space-y-4">
          <div>
            <h4 className="font-medium text-sm mb-3">Assign Roles</h4>
            <div className="space-y-2">
              {availableRoles.length === 0 && (
                <div className="text-xs text-muted-foreground">Loading roles…</div>
              )}
              {availableRoles.map((role) => (
                <div
                  key={role.value}
                  className="flex items-start space-x-2 py-2"
                >
                  <Checkbox
                    id={`role-${role.value}`}
                    checked={selectedRoles.includes(role.value)}
                    onCheckedChange={() => handleRoleToggle(role.value)}
                    className="mt-0.5"
                  />
                  <label
                    htmlFor={`role-${role.value}`}
                    className="flex-1 cursor-pointer"
                  >
                    <div className="font-medium text-sm">{role.label}</div>
                    {role.description && (
                      <div className="text-xs text-muted-foreground">
                        {role.description}
                      </div>
                    )}
                  </label>
                </div>
              ))}
            </div>
          </div>
          
          {!isValid && (
            <div className="text-xs text-destructive">
              At least one role must be selected
            </div>
          )}
          
          <div className="flex justify-end space-x-2 pt-2 border-t">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCancel}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!isValid}
            >
              Save Changes
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}