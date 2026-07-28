"use client";

import { useState } from "react";
import {
  useForm,
  type FieldErrors,
  type UseFormRegister,
  type UseFormReset,
} from "react-hook-form";
import { toast } from "sonner";
import { Loader2, ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { createLogger } from "@/lib/client-logger";

import {
  updateUserProfile,
  type UserProfileData,
} from "@/actions/settings/user-settings.actions";

const log = createLogger({ component: "ProfileTab" });

// ============================================
// Types
// ============================================

interface ProfileFormData {
  jobTitle: string;
  department: string;
  building: string;
  gradeLevels: string[];
  bio: string;
  preferredName: string;
  pronouns: string;
  yearsInDistrict: string;
  certificationAreas: string;
  areasOfExpertise: string;
  startDate: string;
  previousRoles: string;
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
] as const;

// ============================================
// Component
// ============================================

interface ProfileTabProps {
  data: UserProfileData | null;
}

type UserProfileDetails = NonNullable<UserProfileData["profile"]>;

function profileValue<Key extends keyof UserProfileDetails>(
  profile: UserProfileData["profile"],
  key: Key,
): UserProfileDetails[Key] | undefined {
  return profile?.[key];
}

function textValue(value: string | null | undefined): string {
  return value ?? "";
}

function stringArrayValue(value: string[] | null | undefined): string[] {
  return value ?? [];
}

function joinedValue(value: string[] | null | undefined): string {
  return value?.join(", ") ?? "";
}

function profileFormDefaults(data: UserProfileData | null): ProfileFormData {
  if (!data) {
    return {
      jobTitle: "",
      department: "",
      building: "",
      gradeLevels: [],
      bio: "",
      preferredName: "",
      pronouns: "",
      yearsInDistrict: "",
      certificationAreas: "",
      areasOfExpertise: "",
      startDate: "",
      previousRoles: "",
    };
  }
  return {
    jobTitle: textValue(data.jobTitle),
    department: textValue(data.department),
    building: textValue(data.building),
    gradeLevels: stringArrayValue(data.gradeLevels),
    bio: textValue(data.bio),
    preferredName: textValue(profileValue(data.profile, "preferredName")),
    pronouns: textValue(profileValue(data.profile, "pronouns")),
    yearsInDistrict: String(
      profileValue(data.profile, "yearsInDistrict") ?? "",
    ),
    certificationAreas: joinedValue(
      profileValue(data.profile, "certificationAreas"),
    ),
    areasOfExpertise: joinedValue(
      profileValue(data.profile, "areasOfExpertise"),
    ),
    startDate: textValue(profileValue(data.profile, "startDate")),
    previousRoles: joinedValue(profileValue(data.profile, "previousRoles")),
  };
}

function splitCommaSeparated(value: string): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function profileUpdateInput(
  formData: ProfileFormData,
): Parameters<typeof updateUserProfile>[0] {
  const years = formData.yearsInDistrict
    ? Number(formData.yearsInDistrict)
    : undefined;
  return {
    jobTitle: formData.jobTitle || null,
    department: formData.department || null,
    building: formData.building || null,
    gradeLevels: formData.gradeLevels,
    bio: formData.bio || null,
    profile: {
      preferredName: formData.preferredName || undefined,
      pronouns: formData.pronouns || undefined,
      yearsInDistrict:
        years !== undefined && !Number.isNaN(years) ? years : undefined,
      certificationAreas: splitCommaSeparated(formData.certificationAreas),
      areasOfExpertise: splitCommaSeparated(formData.areasOfExpertise),
      startDate: formData.startDate || undefined,
      previousRoles: splitCommaSeparated(formData.previousRoles),
    },
  };
}

function ReadOnlyIdentityFields({ data }: { data: UserProfileData }) {
  const identityFields = [
    { label: "First Name", value: data.firstName },
    { label: "Last Name", value: data.lastName },
  ];
  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {identityFields.map((field) => (
          <div className="space-y-2" key={field.label}>
            <Label>{field.label}</Label>
            <Input value={field.value ?? ""} disabled className="bg-muted" />
            <p className="text-xs text-muted-foreground">
              Managed by your login provider
            </p>
          </div>
        ))}
      </div>
      <div className="space-y-2">
        <Label>Email</Label>
        <Input value={data.email ?? ""} disabled className="bg-muted" />
        <p className="text-xs text-muted-foreground">
          Managed by your login provider
        </p>
      </div>
    </>
  );
}

function EmploymentFields({
  register,
  errors,
}: {
  register: UseFormRegister<ProfileFormData>;
  errors: FieldErrors<ProfileFormData>;
}) {
  const fields = [
    { name: "jobTitle", label: "Job Title", placeholder: "e.g., Math Teacher" },
    {
      name: "department",
      label: "Department",
      placeholder: "e.g., Mathematics",
    },
    { name: "building", label: "Building", placeholder: "e.g., East Campus" },
  ] as const;
  return (
    <div className="border-t pt-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {fields.map((field) => (
          <div className="space-y-2" key={field.name}>
            <Label htmlFor={field.name}>{field.label}</Label>
            <Input
              id={field.name}
              placeholder={field.placeholder}
              {...register(field.name, {
                maxLength: {
                  value: 255,
                  message: "Must be 255 characters or less",
                },
              })}
            />
            {errors[field.name] && (
              <p className="text-sm text-destructive">
                {errors[field.name]?.message}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function GradeLevelFields({
  selectedGrades,
  toggleGrade,
}: {
  selectedGrades: string[];
  toggleGrade: (grade: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>Grade Levels</Label>
      <div className="flex flex-wrap gap-2">
        {GRADE_LEVELS.map((grade) => {
          const selected = selectedGrades.includes(grade.value);
          return (
            <label
              key={grade.value}
              className={cn(
                "flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm cursor-pointer transition-colors",
                selected
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border hover:bg-accent",
              )}
            >
              <Checkbox
                checked={selected}
                onCheckedChange={() => toggleGrade(grade.value)}
                className="sr-only"
              />
              {grade.label}
            </label>
          );
        })}
      </div>
    </div>
  );
}

function BioField({
  register,
  error,
  value,
}: {
  register: UseFormRegister<ProfileFormData>;
  error: FieldErrors<ProfileFormData>["bio"];
  value: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor="bio">Bio</Label>
      <Textarea
        id="bio"
        placeholder="Tell us about yourself..."
        rows={4}
        maxLength={500}
        {...register("bio", {
          maxLength: {
            value: 500,
            message: "Bio must be 500 characters or less",
          },
        })}
      />
      <div className="flex justify-between text-xs text-muted-foreground">
        {error ? <p className="text-destructive">{error.message}</p> : <span />}
        <span
          className={cn(
            value.length > 450 && "text-amber-600",
            value.length >= 500 && "text-destructive font-medium",
          )}
        >
          {value.length}/500
        </span>
      </div>
    </div>
  );
}

function AdditionalProfileFields({
  open,
  onOpenChange,
  register,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  register: UseFormRegister<ProfileFormData>;
}) {
  const commaFields = [
    {
      name: "certificationAreas",
      label: "Certification Areas",
      placeholder: "Comma-separated, e.g., Math, Science",
    },
    {
      name: "areasOfExpertise",
      label: "Areas of Expertise",
      placeholder: "Comma-separated, e.g., AI, Data Science",
    },
    {
      name: "previousRoles",
      label: "Previous Roles",
      placeholder: "Comma-separated, e.g., Teacher, Coach",
    },
  ] as const;
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger asChild>
        <Button variant="outline" type="button" className="w-full">
          {open ? "Hide" : "Show"} Additional Profile Fields
          <ChevronDown
            className={cn(
              "ml-2 h-4 w-4 transition-transform",
              open && "rotate-180",
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
            <Input id="startDate" type="date" {...register("startDate")} />
          </div>
        </div>
        {commaFields.map((field) => (
          <div className="space-y-2" key={field.name}>
            <Label htmlFor={field.name}>{field.label}</Label>
            <Input
              id={field.name}
              placeholder={field.placeholder}
              {...register(field.name)}
            />
            <p className="text-xs text-muted-foreground">
              Separate multiple areas with commas
            </p>
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

function ProfileActions({
  isDirty,
  isSaving,
  reset,
}: {
  isDirty: boolean;
  isSaving: boolean;
  reset: UseFormReset<ProfileFormData>;
}) {
  return (
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
  );
}

export function ProfileTab({ data }: ProfileTabProps) {
  const [isSaving, setIsSaving] = useState(false);
  const [showAdditional, setShowAdditional] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors, isDirty },
  } = useForm<ProfileFormData>({
    defaultValues: profileFormDefaults(data),
  });

  const selectedGrades = watch("gradeLevels") ?? [];
  const bioValue = watch("bio") ?? "";

  function toggleGrade(grade: string) {
    const current = selectedGrades;
    if (current.includes(grade)) {
      setValue(
        "gradeLevels",
        current.filter((g) => g !== grade),
        { shouldDirty: true },
      );
    } else {
      setValue("gradeLevels", [...current, grade], { shouldDirty: true });
    }
  }

  async function onSubmit(formData: ProfileFormData) {
    setIsSaving(true);
    try {
      const result = await updateUserProfile(profileUpdateInput(formData));

      if (result.isSuccess) {
        toast.success(result.message);
        reset(formData);
      } else {
        toast.error(result.message);
      }
    } catch (error) {
      log.error("Profile update failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast.error("An unexpected error occurred");
    } finally {
      setIsSaving(false);
    }
  }

  if (!data) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          Failed to load profile data. Please refresh the page.
        </CardContent>
      </Card>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>
            Update your profile information visible to other users in the
            district.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <ReadOnlyIdentityFields data={data} />
          <EmploymentFields register={register} errors={errors} />
          <GradeLevelFields
            selectedGrades={selectedGrades}
            toggleGrade={toggleGrade}
          />
          <BioField register={register} error={errors.bio} value={bioValue} />
          <AdditionalProfileFields
            open={showAdditional}
            onOpenChange={setShowAdditional}
            register={register}
          />
          <ProfileActions isDirty={isDirty} isSaving={isSaving} reset={reset} />
        </CardContent>
      </Card>
    </form>
  );
}
