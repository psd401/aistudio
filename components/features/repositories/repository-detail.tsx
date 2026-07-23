"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { type Repository } from "@/actions/repositories/repository.actions"
import { RepositoryItemList } from "./repository-item-list"
import { RepositoryAccessEditor } from "./repository-access-editor"
import { RepositorySourcePicker } from "./repository-source-picker"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  ArrowLeft,
  Edit,
  Globe,
  Lock,
  Search,
  Settings,
  Shield,
} from "lucide-react"
import { format } from "date-fns"
import { RepositorySearch } from "./repository-search"

interface RepositoryDetailProps {
  repository: Repository
}

export function RepositoryDetail({ repository }: RepositoryDetailProps) {
  const router = useRouter()
  const [uploadModalOpen, setUploadModalOpen] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  return (
    <>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => router.push("/repositories")}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <h1 className="text-3xl font-bold">{repository.name}</h1>
              {repository.description && (
                <p className="text-muted-foreground mt-1">
                  {repository.description}
                </p>
              )}
            </div>
          </div>
          {repository.canManage ? (
            <Button
              variant="outline"
              onClick={() => router.push(`/repositories/${repository.id}/edit`)}
            >
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </Button>
          ) : (
            <Badge variant="outline" className="gap-1">
              <Shield className="h-3 w-3" />
              Shared read only
            </Badge>
          )}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Repository Information</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <dt className="text-sm font-medium text-muted-foreground">
                  Owner
                </dt>
                <dd className="mt-1 text-sm">{repository.ownerName || "-"}</dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-muted-foreground">
                  Visibility
                </dt>
                <dd className="mt-1">
                  {repository.isPublic ? (
                    <Badge variant="outline" className="gap-1">
                      <Globe className="h-3 w-3" />
                      Public
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="gap-1">
                      <Lock className="h-3 w-3" />
                      Private
                    </Badge>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-muted-foreground">
                  Created
                </dt>
                <dd className="mt-1 text-sm">
                  {repository.createdAt ? format(new Date(repository.createdAt), "PPP") : "-"}
                </dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-muted-foreground">
                  Last Updated
                </dt>
                <dd className="mt-1 text-sm">
                  {repository.updatedAt ? format(new Date(repository.updatedAt), "PPP") : "-"}
                </dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-muted-foreground">
                  Lifecycle
                </dt>
                <dd className="mt-1 flex flex-wrap gap-2">
                  <Badge variant="secondary" className="capitalize">
                    {repository.repositoryKind}
                  </Badge>
                  <Badge
                    variant={
                      repository.lifecycleStatus === "active"
                        ? "default"
                        : "outline"
                    }
                    className="capitalize"
                  >
                    {repository.lifecycleStatus}
                  </Badge>
                </dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-muted-foreground">
                  Retention
                </dt>
                <dd className="mt-1 text-sm">
                  {repository.retentionDays === null
                    ? "Persistent"
                    : `${repository.retentionDays} days`}
                  {repository.expiresAt
                    ? ` · expires ${format(new Date(repository.expiresAt), "PPP")}`
                    : ""}
                </dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-muted-foreground">
                  Active index generation
                </dt>
                <dd className="mt-1 break-all font-mono text-xs">
                  {repository.activeIndexGenerationId || "Not published yet"}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Tabs defaultValue="items" className="space-y-4">
          <TabsList>
            <TabsTrigger value="items">Items</TabsTrigger>
            <TabsTrigger value="search">
              <Search className="mr-2 h-4 w-4" />
              Search
            </TabsTrigger>
            <TabsTrigger value="access">
              <Settings className="mr-2 h-4 w-4" />
              Access Control
            </TabsTrigger>
          </TabsList>

          <TabsContent value="items">
            <RepositoryItemList
              key={refreshKey}
              repositoryId={repository.id}
              canManage={repository.canManage}
              onAddItem={() => setUploadModalOpen(true)}
            />
          </TabsContent>

          <TabsContent value="search">
            <RepositorySearch repositoryId={repository.id} />
          </TabsContent>

          <TabsContent value="access">
            {repository.canManage ? (
              <RepositoryAccessEditor
                repositoryId={repository.id}
                isPublic={repository.isPublic}
              />
            ) : (
              <Card>
                <CardHeader>
                  <CardTitle>Shared repository access</CardTitle>
                  <CardDescription>
                    Access grants are visible only to repository managers.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">
                    You can read and search this repository, but only its owner
                    or an administrator can change content, settings, or access.
                  </p>
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      </div>

      <RepositorySourcePicker
        repositoryId={repository.id}
        open={uploadModalOpen}
        onOpenChange={setUploadModalOpen}
        onSuccess={() => setRefreshKey(prev => prev + 1)}
      />
    </>
  )
}
