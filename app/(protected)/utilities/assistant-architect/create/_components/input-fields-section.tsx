"use client"

import { useCallback, useState } from "react"
import { Button } from "@/components/ui/button"
import { Plus, Pencil, Trash2 } from "lucide-react"
import type { SelectToolInputField } from "@/types"
import { InputFieldEditor, InputFieldData } from "./input-field-editor"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

interface InputFieldsSectionProps {
  inputFields: SelectToolInputField[]
  onAddField: () => Promise<string | null>
  onSaveField: (data: InputFieldData, editingField: SelectToolInputField | null) => Promise<void>
  onDeleteField: (field: SelectToolInputField) => Promise<void>
  isSubmitting: boolean
}

export function InputFieldsSection({
  inputFields,
  onAddField,
  onSaveField,
  onDeleteField,
  isSubmitting
}: InputFieldsSectionProps) {
  const [showFieldEditor, setShowFieldEditor] = useState(false)
  const [editingField, setEditingField] = useState<SelectToolInputField | null>(null)
  const [fieldToDelete, setFieldToDelete] = useState<SelectToolInputField | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const handleAddFieldClick = useCallback(async () => {
    const savedId = await onAddField()
    if (savedId) {
      setEditingField(null)
      setShowFieldEditor(true)
    }
  }, [onAddField])

  const handleFieldSave = useCallback(async (data: InputFieldData) => {
    await onSaveField(data, editingField)
    setShowFieldEditor(false)
    setEditingField(null)
  }, [onSaveField, editingField])

  const handleCancelEdit = useCallback(() => {
    setShowFieldEditor(false)
    setEditingField(null)
  }, [])

  const handleEditField = useCallback((field: SelectToolInputField) => {
    setEditingField(field)
    setShowFieldEditor(true)
  }, [])

  const handleDeleteClick = useCallback((field: SelectToolInputField) => {
    setFieldToDelete(field)
  }, [])

  const handleDeleteConfirm = useCallback(async () => {
    if (!fieldToDelete) return

    setIsDeleting(true)
    await onDeleteField(fieldToDelete)
    setIsDeleting(false)
    setFieldToDelete(null)
  }, [fieldToDelete, onDeleteField])

  const handleDeleteCancel = useCallback(() => {
    setFieldToDelete(null)
  }, [])

  return (
    <div className="space-y-4 border-t pt-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium">Input Fields</h3>
          <p className="text-sm text-muted-foreground">
            Define the fields users will fill out when using this assistant.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={handleAddFieldClick}
          disabled={isSubmitting}
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Field
        </Button>
      </div>

      {showFieldEditor && (
        <InputFieldEditor
          key={editingField?.id ?? "new"}
          existingFields={inputFields}
          editingField={editingField}
          onSave={handleFieldSave}
          onCancel={handleCancelEdit}
          nextPosition={inputFields.length}
        />
      )}

      {inputFields.length > 0 && (
        <InputFieldList
          fields={inputFields}
          onEdit={handleEditField}
          onDelete={handleDeleteClick}
        />
      )}

      {inputFields.length === 0 && !showFieldEditor && (
        <div className="text-center py-8 text-muted-foreground border rounded-lg border-dashed">
          No input fields added yet. Click &quot;Add Field&quot; to define user inputs.
        </div>
      )}

      <DeleteFieldDialog
        field={fieldToDelete}
        isDeleting={isDeleting}
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
      />
    </div>
  )
}

interface InputFieldListProps {
  fields: SelectToolInputField[]
  onEdit: (field: SelectToolInputField) => void
  onDelete: (field: SelectToolInputField) => void
}

function InputFieldList({ fields, onEdit, onDelete }: InputFieldListProps) {
  const sortedFields = [...fields].sort((a, b) => a.position - b.position)

  return (
    <div className="space-y-2">
      {sortedFields.map((field) => (
        <InputFieldItem
          key={field.id}
          field={field}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ))}
    </div>
  )
}

interface InputFieldItemProps {
  field: SelectToolInputField
  onEdit: (field: SelectToolInputField) => void
  onDelete: (field: SelectToolInputField) => void
}

function InputFieldItem({ field, onEdit, onDelete }: InputFieldItemProps) {
  const handleEdit = useCallback(() => {
    onEdit(field)
  }, [onEdit, field])

  const handleDelete = useCallback(() => {
    onDelete(field)
  }, [onDelete, field])

  const displayType = field.fieldType
    ? field.fieldType.split("_").map(word =>
        word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
      ).join(" ")
    : "Unknown"

  return (
    <div className="flex items-center justify-between p-3 border rounded-lg bg-card">
      <div className="space-y-0.5">
        <div className="font-medium">{field.label || field.name}</div>
        <div className="text-sm text-muted-foreground">
          {displayType} &bull; Position {field.position}
        </div>
      </div>

      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          onClick={handleEdit}
          aria-label={`Edit ${field.label || field.name}`}
        >
          <Pencil className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleDelete}
          aria-label={`Delete ${field.label || field.name}`}
        >
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </div>
    </div>
  )
}

interface DeleteFieldDialogProps {
  field: SelectToolInputField | null
  isDeleting: boolean
  onConfirm: () => void
  onCancel: () => void
}

function DeleteFieldDialog({ field, isDeleting, onConfirm, onCancel }: DeleteFieldDialogProps) {
  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) onCancel()
  }, [onCancel])

  return (
    <AlertDialog open={!!field} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Input Field</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete &quot;{field?.label || field?.name}&quot;?
            This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={isDeleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isDeleting ? "Deleting..." : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
