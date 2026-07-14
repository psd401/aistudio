"use client";

/**
 * State + persistence hook for the per-resource access grants editor (#1206).
 * Loads the selectable options and the resource's current grants, tracks the
 * pending role/group selections, and persists them via the admin-only server
 * actions. Extracted from ResourceGrantsEditor to keep that component lean.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useToast } from "@/components/ui/use-toast";
import {
  getResourceGrantOptionsAction,
  getResourceGrantsAction,
  updateResourceGrantsAction,
  type ResourceGrantOptions,
} from "@/actions/db/resource-grants-actions";

export type ResourceType = "model" | "assistant" | "skill";

/** Compare two string arrays as case-insensitive sets (order-independent). */
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = new Set(b.map((x) => x.toLowerCase()));
  return a.every((x) => sb.has(x.toLowerCase()));
}

export interface UseResourceGrants {
  loading: boolean;
  saving: boolean;
  error: string | null;
  options: ResourceGrantOptions;
  roleValues: string[];
  groupValues: string[];
  setRoleValues: (v: string[]) => void;
  setGroupValues: (v: string[]) => void;
  isDirty: boolean;
  isUnrestricted: boolean;
  reload: () => void;
  reset: () => void;
  save: () => Promise<void>;
}

export function useResourceGrants(
  resourceType: ResourceType,
  resourceId: number | string,
  onSaved?: () => void
): UseResourceGrants {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<ResourceGrantOptions>({ roles: [], groups: [] });
  const [roleValues, setRoleValues] = useState<string[]>([]);
  const [groupValues, setGroupValues] = useState<string[]>([]);
  const [savedRoles, setSavedRoles] = useState<string[]>([]);
  const [savedGroups, setSavedGroups] = useState<string[]>([]);

  const applyGrants = useCallback(
    (grants: { grantKind: "role" | "group"; grantValue: string }[]) => {
      const roles = grants.filter((g) => g.grantKind === "role").map((g) => g.grantValue);
      const groups = grants.filter((g) => g.grantKind === "group").map((g) => g.grantValue);
      setRoleValues(roles);
      setGroupValues(groups);
      setSavedRoles(roles);
      setSavedGroups(groups);
    },
    []
  );

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [optRes, grantsRes] = await Promise.all([
        getResourceGrantOptionsAction(),
        getResourceGrantsAction(resourceType, resourceId),
      ]);
      if (!optRes.isSuccess) throw new Error(optRes.message);
      if (!grantsRes.isSuccess) throw new Error(grantsRes.message);
      setOptions(optRes.data);
      applyGrants(grantsRes.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load access grants");
    } finally {
      setLoading(false);
    }
  }, [resourceType, resourceId, applyGrants]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const isDirty = useMemo(
    () => !sameSet(roleValues, savedRoles) || !sameSet(groupValues, savedGroups),
    [roleValues, savedRoles, groupValues, savedGroups]
  );
  const isUnrestricted = roleValues.length === 0 && groupValues.length === 0;

  const reset = useCallback(() => {
    setRoleValues(savedRoles);
    setGroupValues(savedGroups);
  }, [savedRoles, savedGroups]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const grants = [
        ...roleValues.map((v) => ({ grantKind: "role" as const, grantValue: v })),
        ...groupValues.map((v) => ({ grantKind: "group" as const, grantValue: v })),
      ];
      const res = await updateResourceGrantsAction(resourceType, resourceId, grants);
      if (!res.isSuccess) throw new Error(res.message);
      applyGrants(res.data);
      toast({
        title: "Access updated",
        description:
          res.data.length === 0
            ? "This resource is now available to everyone."
            : "Access restricted to the selected roles and groups.",
      });
      onSaved?.();
    } catch (e) {
      toast({
        title: "Could not update access",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }, [roleValues, groupValues, resourceType, resourceId, applyGrants, toast, onSaved]);

  return {
    loading,
    saving,
    error,
    options,
    roleValues,
    groupValues,
    setRoleValues,
    setGroupValues,
    isDirty,
    isUnrestricted,
    reload: () => void reload(),
    reset,
    save,
  };
}
