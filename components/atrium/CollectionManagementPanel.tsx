"use client";

/**
 * Shared collection editor for the library's private-collection dialog and the
 * administrator's district hierarchy panel (#1438).
 */

import { useEffect, useMemo, useState, useTransition } from "react";
import { Archive, FolderPlus, RotateCcw, Save } from "lucide-react";
import {
  createCollectionAction,
  listManageableCollectionsAction,
  updateCollectionAction,
} from "@/actions/db/atrium/collection-management";
import {
  listGrantOptionsAction,
  type GrantOptions,
} from "@/actions/db/atrium/list-grant-options";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type {
  CollectionDTO,
  CollectionGrant,
  VisibilityLevel,
} from "@/lib/content";

interface CollectionManagementPanelProps {
  mode: "admin" | "private";
  initialCollections?: CollectionDTO[];
  initialError?: string | null;
}

interface EditorState {
  id: string | null;
  name: string;
  parentId: string;
  position: string;
  defaultVisibilityLevel: VisibilityLevel;
  inheritGrants: boolean;
  grants: CollectionGrant[];
}

const EMPTY_EDITOR: EditorState = {
  id: null,
  name: "",
  parentId: "",
  position: "",
  defaultVisibilityLevel: "internal",
  inheritGrants: true,
  grants: [],
};

function editorFor(row: CollectionDTO): EditorState {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parentId ?? "",
    position: String(row.position),
    defaultVisibilityLevel: row.defaultVisibilityLevel,
    inheritGrants: row.inheritGrants,
    grants: row.grants,
  };
}

function ordered(rows: CollectionDTO[]): CollectionDTO[] {
  const compare = (left: CollectionDTO, right: CollectionDTO) =>
    left.position - right.position || left.name.localeCompare(right.name);
  const children = new Map<string | null, CollectionDTO[]>();
  for (const row of rows) {
    const siblings = children.get(row.parentId) ?? [];
    siblings.push(row);
    children.set(row.parentId, siblings);
  }
  for (const siblings of children.values()) siblings.sort(compare);

  const result: CollectionDTO[] = [];
  const seen = new Set<string>();
  const visit = (row: CollectionDTO) => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    result.push(row);
    for (const child of children.get(row.id) ?? []) visit(child);
  };
  for (const root of children.get(null) ?? []) visit(root);
  // Defensive fallback for legacy orphan/cycle rows: display each once.
  for (const row of [...rows].sort(compare)) visit(row);
  return result;
}

function announceTreeChange(): void {
  window.dispatchEvent(new Event("atrium:collections-changed"));
}

function GrantEditor({
  grants,
  options,
  disabled,
  onChange,
}: {
  grants: CollectionGrant[];
  options: GrantOptions;
  disabled: boolean;
  onChange: (grants: CollectionGrant[]) => void;
}): React.JSX.Element {
  function patch(index: number, grant: CollectionGrant): void {
    onChange(grants.map((current, i) => (i === index ? grant : current)));
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>Role and group access</Label>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() =>
            onChange([
              ...grants,
              { access: "view", kind: "role", value: options.roles[0] ?? "" },
            ])
          }
        >
          Add grant
        </Button>
      </div>
      {grants.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No grants: authenticated users retain legacy access.
        </p>
      ) : null}
      {grants.map((grant, index) => {
        const values =
          grant.kind === "role"
            ? options.roles
            : grant.kind === "group"
              ? options.groups.map((group) => group.email)
              : [];
        return (
          <div
            key={`${index}-${grant.access}-${grant.kind}`}
            className="grid gap-2 sm:grid-cols-[110px_110px_1fr_auto]"
          >
            <select
              aria-label={`Grant ${index + 1} access`}
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={grant.access}
              disabled={disabled}
              onChange={(event) =>
                patch(index, {
                  ...grant,
                  access: event.target.value as CollectionGrant["access"],
                })
              }
            >
              <option value="view">View</option>
              <option value="create">Create</option>
            </select>
            <select
              aria-label={`Grant ${index + 1} kind`}
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={grant.kind}
              disabled={disabled}
              onChange={(event) => {
                const kind = event.target.value as CollectionGrant["kind"];
                patch(index, {
                  access: grant.access,
                  kind,
                  value:
                    kind === "role"
                      ? options.roles[0] ?? ""
                      : kind === "group"
                        ? options.groups[0]?.email ?? ""
                        : "",
                });
              }}
            >
              <option value="role">Role</option>
              <option value="group">Group</option>
              <option value="building">Building</option>
              <option value="department">Department</option>
              <option value="grade">Grade</option>
              <option value="user">User ID</option>
            </select>
            {grant.kind === "role" || grant.kind === "group" ? (
              <select
                aria-label={`Grant ${index + 1} value`}
                className="h-9 min-w-0 rounded-md border bg-background px-2 text-sm"
                value={grant.value}
                disabled={disabled}
                onChange={(event) =>
                  patch(index, { ...grant, value: event.target.value })
                }
              >
                {!values.includes(grant.value) && grant.value ? (
                  <option value={grant.value}>{grant.value}</option>
                ) : null}
                {values.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                aria-label={`Grant ${index + 1} value`}
                value={grant.value}
                disabled={disabled}
                onChange={(event) =>
                  patch(index, { ...grant, value: event.target.value })
                }
              />
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => onChange(grants.filter((_, i) => i !== index))}
            >
              Remove
            </Button>
          </div>
        );
      })}
    </div>
  );
}

function CollectionList({
  mode,
  rows,
  onNew,
  onSelect,
}: {
  mode: CollectionManagementPanelProps["mode"];
  rows: CollectionDTO[];
  onNew: () => void;
  onSelect: (row: CollectionDTO) => void;
}): React.JSX.Element {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">
          {mode === "private" ? "My private collections" : "All collections"}
        </h3>
        <Button type="button" size="sm" variant="outline" onClick={onNew}>
          <FolderPlus className="mr-1 h-4 w-4" />
          New
        </Button>
      </div>
      <div className="max-h-[480px] space-y-1 overflow-y-auto">
        {rows.map((row) => (
          <button
            type="button"
            key={row.id}
            className="flex w-full items-start justify-between rounded-md border px-3 py-2 text-left hover:bg-muted/50"
            onClick={() => onSelect(row)}
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">
                {row.path.join(" / ")}
              </span>
              <span className="block text-xs text-muted-foreground">
                {row.directContentCount} direct · {row.subtreeContentCount} subtree
                {row.ownerName ? ` · ${row.ownerName}` : ""}
              </span>
            </span>
            <span className="ml-2 flex gap-1">
              <Badge variant="outline">{row.scope}</Badge>
              {row.archivedAt ? (
                <Badge variant="secondary">Archived</Badge>
              ) : null}
            </span>
          </button>
        ))}
        {rows.length === 0 ? (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            No collections yet.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function CollectionBasics({
  mode,
  editor,
  parentOptions,
  readOnly,
  onChange,
}: {
  mode: CollectionManagementPanelProps["mode"];
  editor: EditorState;
  parentOptions: CollectionDTO[];
  readOnly: boolean;
  onChange: (editor: EditorState) => void;
}): React.JSX.Element {
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={`${mode}-collection-name`}>Name</Label>
        <Input
          id={`${mode}-collection-name`}
          value={editor.name}
          maxLength={200}
          disabled={readOnly}
          onChange={(event) =>
            onChange({ ...editor, name: event.target.value })
          }
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${mode}-collection-parent`}>Parent</Label>
          <select
            id={`${mode}-collection-parent`}
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            value={editor.parentId}
            disabled={readOnly}
            onChange={(event) =>
              onChange({ ...editor, parentId: event.target.value })
            }
          >
            <option value="">Top level</option>
            {parentOptions.map((row) => (
              <option key={row.id} value={row.id}>
                {row.path.join(" / ")}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${mode}-collection-position`}>Order</Label>
          <Input
            id={`${mode}-collection-position`}
            type="number"
            min={0}
            value={editor.position}
            disabled={readOnly}
            onChange={(event) =>
              onChange({ ...editor, position: event.target.value })
            }
          />
        </div>
      </div>
    </>
  );
}

function DistrictCollectionOptions({
  editor,
  grantOptions,
  readOnly,
  onChange,
}: {
  editor: EditorState;
  grantOptions: GrantOptions;
  readOnly: boolean;
  onChange: (editor: EditorState) => void;
}): React.JSX.Element {
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="district-default-visibility">
          Default content visibility
        </Label>
        <select
          id="district-default-visibility"
          className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          value={editor.defaultVisibilityLevel}
          disabled={readOnly}
          onChange={(event) =>
            onChange({
              ...editor,
              defaultVisibilityLevel: event.target.value as VisibilityLevel,
            })
          }
        >
          <option value="private">Private</option>
          <option value="group">Group</option>
          <option value="internal">Internal</option>
          <option value="public">Public</option>
        </select>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id="district-inherit-grants"
          checked={editor.inheritGrants}
          disabled={readOnly}
          onCheckedChange={(checked) =>
            onChange({ ...editor, inheritGrants: checked === true })
          }
        />
        <Label htmlFor="district-inherit-grants">
          Inherit view/create grants from parent
        </Label>
      </div>
      <GrantEditor
        grants={editor.grants}
        options={grantOptions}
        disabled={readOnly}
        onChange={(grants) => onChange({ ...editor, grants })}
      />
    </>
  );
}

function CollectionEditor({
  mode,
  editor,
  grantOptions,
  parentOptions,
  selected,
  readOnly,
  error,
  notice,
  isPending,
  onChange,
  onSave,
  onToggleArchived,
}: {
  mode: CollectionManagementPanelProps["mode"];
  editor: EditorState;
  grantOptions: GrantOptions;
  parentOptions: CollectionDTO[];
  selected: CollectionDTO | null;
  readOnly: boolean;
  error: string | null;
  notice: string | null;
  isPending: boolean;
  onChange: (editor: EditorState) => void;
  onSave: () => void;
  onToggleArchived: (row: CollectionDTO) => void;
}): React.JSX.Element {
  return (
    <section className="space-y-4 rounded-lg border p-4">
      <div>
        <h3 className="font-medium">
          {editor.id ? "Collection settings" : "Create collection"}
        </h3>
        {readOnly ? (
          <p className="text-xs text-muted-foreground">
            Private collections are owner-bound and read-only to administrators.
          </p>
        ) : null}
      </div>
      <CollectionBasics
        mode={mode}
        editor={editor}
        parentOptions={parentOptions}
        readOnly={readOnly}
        onChange={onChange}
      />
      {mode === "admin" ? (
        <DistrictCollectionOptions
          editor={editor}
          grantOptions={grantOptions}
          readOnly={readOnly}
          onChange={onChange}
        />
      ) : (
        <p className="text-xs text-muted-foreground">
          Private collections and their contents are visible only to you.
        </p>
      )}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="text-sm text-emerald-700" role="status">
          {notice}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        {selected && !readOnly ? (
          <Button
            type="button"
            variant="outline"
            disabled={isPending}
            onClick={() => onToggleArchived(selected)}
          >
            {selected.archivedAt ? (
              <RotateCcw className="mr-1 h-4 w-4" />
            ) : (
              <Archive className="mr-1 h-4 w-4" />
            )}
            {selected.archivedAt ? "Restore subtree" : "Archive subtree"}
          </Button>
        ) : null}
        <Button
          type="button"
          disabled={isPending || readOnly || !editor.name.trim()}
          onClick={onSave}
        >
          <Save className="mr-1 h-4 w-4" />
          {isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </section>
  );
}

export function CollectionManagementPanel({
  mode,
  initialCollections = [],
  initialError = null,
}: CollectionManagementPanelProps): React.JSX.Element {
  const [collections, setCollections] = useState(initialCollections);
  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR);
  const [grantOptions, setGrantOptions] = useState<GrantOptions>({
    roles: [],
    groups: [],
  });
  const [error, setError] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const rows = useMemo(() => ordered(collections), [collections]);
  const selected = editor.id
    ? collections.find((row) => row.id === editor.id) ?? null
    : null;
  const readOnly = mode === "admin" && selected?.scope === "private";
  const parentOptions = rows.filter(
    (row) =>
      row.id !== editor.id &&
      !row.archivedAt &&
      row.scope === (mode === "private" ? "private" : "district")
  );

  function refresh(selectId?: string): void {
    startTransition(async () => {
      const result = await listManageableCollectionsAction(mode);
      if (!result.isSuccess) {
        setError(result.message ?? "Failed to refresh collections");
        return;
      }
      const next = result.data ?? [];
      setCollections(next);
      if (selectId) {
        const row = next.find((item) => item.id === selectId);
        if (row) setEditor(editorFor(row));
      }
      setError(null);
    });
  }

  useEffect(() => {
    if (initialCollections.length === 0) refresh();
    if (mode === "admin") {
      void listGrantOptionsAction().then((result) => {
        if (result.isSuccess && result.data) setGrantOptions(result.data);
      });
    }
    // Initial props are deliberately a one-time server snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  function save(): void {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const position = editor.position.trim()
        ? Number(editor.position)
        : undefined;
      const result = editor.id
        ? await updateCollectionAction(editor.id, {
            name: editor.name,
            parentId: editor.parentId || null,
            position,
            ...(mode === "admin" && !readOnly
              ? {
                  defaultVisibilityLevel: editor.defaultVisibilityLevel,
                  inheritGrants: editor.inheritGrants,
                  grants: editor.grants,
                }
              : {}),
          })
        : await createCollectionAction({
            name: editor.name,
            scope: mode === "private" ? "private" : "district",
            parentId: editor.parentId || null,
            position,
            ...(mode === "admin"
              ? {
                  defaultVisibilityLevel: editor.defaultVisibilityLevel,
                  inheritGrants: editor.inheritGrants,
                  grants: editor.grants,
                }
              : {}),
          });
      if (!result.isSuccess || !result.data) {
        setError(result.message ?? "Failed to save collection");
        return;
      }
      setNotice(editor.id ? "Collection updated" : "Collection created");
      announceTreeChange();
      refresh(result.data.id);
    });
  }

  function toggleArchived(row: CollectionDTO): void {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await updateCollectionAction(row.id, {
        archived: !row.archivedAt,
      });
      if (!result.isSuccess) {
        setError(result.message ?? "Failed to update collection");
        return;
      }
      setNotice(row.archivedAt ? "Collection restored" : "Collection archived");
      announceTreeChange();
      refresh(row.id);
    });
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(260px,0.8fr)_minmax(360px,1.2fr)]">
      <CollectionList
        mode={mode}
        rows={rows}
        onNew={() =>
          setEditor({
            ...EMPTY_EDITOR,
            defaultVisibilityLevel:
              mode === "private" ? "private" : "internal",
            inheritGrants: mode !== "private",
          })
        }
        onSelect={(row) => setEditor(editorFor(row))}
      />
      <CollectionEditor
        mode={mode}
        editor={editor}
        grantOptions={grantOptions}
        parentOptions={parentOptions}
        selected={selected}
        readOnly={readOnly}
        error={error}
        notice={notice}
        isPending={isPending}
        onChange={setEditor}
        onSave={save}
        onToggleArchived={toggleArchived}
      />
    </div>
  );
}
