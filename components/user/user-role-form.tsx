'use client';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useEffect, useState } from 'react';
import logger from '@/lib/logger';
import { getRoles } from '@/actions/admin/user-management.actions';

interface UserRoleFormProps {
  userId: string;
  initialRole: string;
  userName?: string;
  userEmail?: string;
  disabled?: boolean;
}

/** Title-case a raw role name for display (e.g. "staff" → "Staff"). */
function toRoleLabel(name: string): string {
  return name.length > 0 ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

export function UserRoleForm({ userId, initialRole, userName, userEmail, disabled }: UserRoleFormProps) {
  const [role, setRole] = useState(initialRole);
  const [isLoading, setIsLoading] = useState(false);
  // Roles are dynamic (#1204) — never a hardcoded list. Seed with the current
  // role so the selected value renders before the fetch resolves.
  const [roles, setRoles] = useState<string[]>(initialRole ? [initialRole] : []);

  useEffect(() => {
    let active = true;
    getRoles()
      .then((result) => {
        if (active && result.isSuccess) {
          setRoles(result.data.map((r) => r.name));
        }
      })
      .catch(() => {
        /* non-fatal: keep the seeded current role until the fetch resolves */
      });
    return () => {
      active = false;
    };
  }, []);

  async function updateRole(newRole: string) {
    setIsLoading(true);
    try {
      const response = await fetch(`/api/admin/users/${userId}/role`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole })
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('Failed to update role', errorText);
        alert('Failed to update role');
        setRole(initialRole); // Reset to initial role on failure
      }
    } catch (error) {
      logger.error('Error updating role', error);
      alert('Failed to update role');
      setRole(initialRole); // Reset to initial role on error
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-4 flex-1">
      {userName && <div className="font-medium">{userName}</div>}
      {userEmail && <div className="text-sm text-muted-foreground">{userEmail}</div>}
      <Select
        defaultValue={role}
        onValueChange={(value) => {
          setRole(value);
          updateRole(value);
        }}
        disabled={isLoading || disabled}
      >
        <SelectTrigger data-testid="role-select" className="w-[180px]">
          <SelectValue placeholder="Select a role" />
        </SelectTrigger>
        <SelectContent>
          {roles.map((roleName) => (
            <SelectItem key={roleName} value={roleName}>
              {toRoleLabel(roleName)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
} 