"use client"

import { useState } from "react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { Loader2, ChevronDown } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"

import {
  updateUserProfile,
  type UserProfileData,
} from "@/actions/settings/user-settings.actions"

// ============================================
// Types
// ============================================

interface ProfileFormData {
  jobTitle: string
  department: string
  building: string
  gradeLevels: string[]
  bio: string
  preferredName: string
  pronouns: string
  yearsInDistrict: string
  certificationAreas: string
  areasOfExpertise: string
  startDate: string
  previousRoles: string
}

// ============================================
// Grade Level Options
// ============================================

const GRADE_LEVELS = [
  { value: "PK", label: "Pre-K" },
  { value: "K", label: "Kindergarten" },
  { value: "1", label: "1st" },
  { value: "2", label: "2nd" },
  { value: "3", label: "3rd" },
  { value: "4", label: "4th" },
  { value: "5", label: "5th" },
  { value: "6", label: "6th" },
  { value: "7", label: "7th" },
  { value: "8", label: "8th" },
  { value: "9", label: "9th" },
  { value: "10", label: "10th" },
  { value: "11", label: "11th" },
  { value: "12", label: "12th" },
] as const

// ============================================
// Component
// ============================================

interface ProfileTabProps {
  data: UserProfileData | null
}

export function ProfileTab({ data }: ProfileTabProps) {
  const [isSaving, setIsSaving] = useState(false)
  const [showAdditional, setShowAdditional] = useState(false)

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors, isDirty },
  } = useForm<ProfileFormData>({
    defaultValues: {
      jobTitle: data?.jobTitle ?? "",
      department: data?.department ?? "",
      building: data?.building ?? "",
      gradeLevels: data?.gradeLevels ?? [],
      bio: data?.bio ?? "",
      preferredName: data?.profile?.preferredName ?? "",
      pronouns: data?.profile?.pronouns ?? "",
      yearsInDistrict: data?.profile?.yearsInDistrict?.toString() ?? "",
      certificationAreas: data?.profile?.certificationAreas?.join(", ") ?? "",
      areasOfExpertise: data?.profile?.areasOfExpertise?.join(", ") ?? "",
      startDate: data?.profile?.startDate ?? "",
      previousRoles: data?.profile?.previousRoles?.join(", ") ?? "",
    },
  })

  const selectedGrades = watch("gradeLevels") ?? []
  const bioValue = watch("bio") ?? ""

  function toggleGrade(grade: string) {
    const current = selectedGrades
    if (current.includes(grade)) {
      setValue(
        "gradeLevels",
        current.filter((g) => g !== grade),
        { shouldDirty: true }
      )
    } else {
      setValue("gradeLevels", [...current, grade], { shouldDirty: true })
    }
  }

  async function onSubmit(formData: ProfileFormData) {
    setIsSaving(true)
    try {
      // Split comma-separated strings into arrays for JSONB fields
      const certAreas = formData.certificationAreas
        ? formData.certificationAreas.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined
      const expertise = formData.areasOfExpertise
        ? formData.areasOfExpertise.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined
      const prevRoles = formData.previousRoles
        ? formData.previousRoles.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined

      const yearsNum = formData.yearsInDistrict
        ? Number(formData.yearsInDistrict)
        : undefined

      const result = await updateUserProfile({
        jobTitle: formData.jobTitle || null,
        department: formData.department || null,
        building: formData.building || null,
        gradeLevels: formData.gradeLevels,
        bio: formData.bio || null,
        profile: {
          preferredName: formData.preferredName || undefined,
          pronouns: formData.pronouns || undefined,
          yearsInDistrict: yearsNum !== undefined && !Number.isNaN(yearsNum)
            ? yearsNum
            : undefined,
          certificationAreas: certAreas,
          areasOfExpertise: expertise,
          startDate: formData.startDate || undefined,
          previousRoles: prevRoles,
        },
      })

      if (result.isSuccess) {
        toast.success(result.message)
        reset(formData)
      } else {
        toast.error(result.message)
      }
    } catch {
      toast.error("An unexpected error occurred")
    } finally {
      setIsSaving(false)
    }
  }

  if (!data) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          Failed to load profile data. Please refresh the page.
        </CardContent>
      </Card>
    )
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>
            Update your profile information visible to other users in the district.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Read-only fields */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>First Name</Label>
              <Input value={data.firstName ?? ""} disabled className="bg-muted" />
              <p className="text-xs text-muted-foreground">
                Managed by your login provider
              </p>
            </div>
            <div className="space-y-2">
              <Label>Last Name</Label>
              <Input value={data.lastName ?? ""} disabled className="bg-muted" />
              <p className="text-xs text-muted-foreground">
                Managed by your login provider
              </p>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Email</Label>
            <Input value={data.email ?? ""} disabled className="bg-muted" />
            <p className="text-xs text-muted-foreground">
              Managed by your login provider
            </p>
          </div>

          {/* Editable fields */}
          <div className="border-t pt-6">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="jobTitle">Job Title</Label>
                <Input
                  id="jobTitle"
                  placeholder="e.g., Math Teacher"
                  {...register("jobTitle", {
                    maxLength: { value: 255, message: "Must be 255 characters or less" },
                  })}
                />
                {errors.jobTitle && (
                  <p className="text-sm text-destructive">{errors.jobTitle.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="department">Department</Label>
                <Input
                  id="department"
                  placeholder="e.g., Mathematics"
                  {...register("department", {
                    maxLength: { value: 255, message: "Must be 255 characters or less" },
                  })}
                />
                {errors.department && (
                  <p className="text-sm text-destructive">{errors.department.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="building">Building</Label>
                <Input
                  id="building"
                  placeholder="e.g., East Campus"
                  {...register("building", {
                    maxLength: { value: 255, message: "Must be 255 characters or less" },
                  })}
                />
                {errors.building && (
                  <p className="text-sm text-destructive">{errors.building.message}</p>
                )}
              </div>
            </div>
          </div>

          {/* Grade Levels */}
          <div className="space-y-2">
            <Label>Grade Levels</Label>
            <div className="flex flex-wrap gap-2">
              {GRADE_LEVELS.map((grade) => (
                <label
                  key={grade.value}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm cursor-pointer transition-colors",
                    selectedGrades.includes(grade.value)
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border hover:bg-accent"
                  )}
                >
                  <Checkbox
                    checked={selectedGrades.includes(grade.value)}
                    onCheckedChange={() => toggleGrade(grade.value)}
                    className="sr-only"
                  />
                  {grade.label}
                </label>
              ))}
            </div>
          </div>

          {/* Bio */}
          <div className="space-y-2">
            <Label htmlFor="bio">Bio</Label>
            <Textarea
              id="bio"
              placeholder="Tell us about yourself..."
              rows={4}
              maxLength={500}
              {...register("bio", {
                maxLength: { value: 500, message: "Bio must be 500 characters or less" },
              })}
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              {errors.bio ? (
                <p className="text-destructive">{errors.bio.message}</p>
              ) : (
                <span />
              )}
              <span
                className={cn(
                  bioValue.length > 450 && "text-amber-600",
                  bioValue.length >= 500 && "text-destructive font-medium"
                )}
              >
                {bioValue.length}/500
              </span>
            </div>
          </div>

          {/* Additional Profile Fields (collapsible) */}
          <Collapsible open={showAdditional} onOpenChange={setShowAdditional}>
            <CollapsibleTrigger asChild>
              <Button variant="outline" type="button" className="w-full">
                {showAdditional ? "Hide" : "Show"} Additional Profile Fields
                <ChevronDown
                  className={cn(
                    "ml-2 h-4 w-4 transition-transform",
                    showAdditional && "rotate-180"
                  )}
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-4 pt-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="preferredName">Preferred Name</Label>
                  <Input
                    id="preferredName"
                    placeholder="How you'd like to be called"
                    {...register("preferredName")}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pronouns">Pronouns</Label>
                  <Input
                    id="pronouns"
                    placeholder="e.g., they/them"
                    {...register("pronouns")}
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="yearsInDistrict">Years in District</Label>
                  <Input
                    id="yearsInDistrict"
                    type="number"
                    min={0}
                    max={50}
                    {...register("yearsInDistrict")}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="startDate">Start Date</Label>
                  <Input
                    id="startDate"
                    type="date"
                    {...register("startDate")}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="certificationAreas">Certification Areas</Label>
                <Input
                  id="certificationAreas"
                  placeholder="Comma-separated, e.g., Math, Science"
                  {...register("certificationAreas")}
                />
                <p className="text-xs text-muted-foreground">
                  Separate multiple areas with commas
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="areasOfExpertise">Areas of Expertise</Label>
                <Input
                  id="areasOfExpertise"
                  placeholder="Comma-separated, e.g., AI, Data Science"
                  {...register("areasOfExpertise")}
                />
                <p className="text-xs text-muted-foreground">
                  Separate multiple areas with commas
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="previousRoles">Previous Roles</Label>
                <Input
                  id="previousRoles"
                  placeholder="Comma-separated, e.g., Teacher, Coach"
                  {...register("previousRoles")}
                />
                <p className="text-xs text-muted-foreground">
                  Separate multiple roles with commas
                </p>
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* Actions */}
          <div className="flex justify-end gap-2 border-t pt-4">
            <Button
              type="button"
              variant="outline"
              disabled={!isDirty || isSaving}
              onClick={() => reset()}
            >
              Reset
            </Button>
            <Button type="submit" disabled={!isDirty || isSaving}>
              {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Changes
            </Button>
          </div>
        </CardContent>
      </Card>
    </form>
  )
}
