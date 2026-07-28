import * as cdk from "aws-cdk-lib"
import { IConstruct } from "constructs"

export interface TaggingConfig {
  environment: string
  projectName: string
  owner: string
  stackName: string
  additionalTags?: Record<string, string>
}

export class TaggingAspect implements cdk.IAspect {
  constructor(private readonly config: TaggingConfig) {}

  public visit(node: IConstruct): void {
    if (cdk.TagManager.isTaggable(node)) {
      const taggable = node as cdk.ITaggable

      // Core tags
      taggable.tags.setTag(
        "Environment",
        this.capitalizeFirst(this.config.environment)
      )
      taggable.tags.setTag("Project", this.config.projectName)
      taggable.tags.setTag("Owner", this.config.owner)
      taggable.tags.setTag("Stack", this.config.stackName)
      taggable.tags.setTag("ManagedBy", "CDK")
      taggable.tags.setTag("DeployedAt", new Date().toISOString())

      // Cost allocation tags
      taggable.tags.setTag("CostCenter", this.getCostCenter())
      taggable.tags.setTag("BusinessUnit", "Technology")

      // Compliance tags
      taggable.tags.setTag(
        "DataClassification",
        this.getDataClassification(node)
      )
      taggable.tags.setTag(
        "Compliance",
        this.config.environment === "prod" ? "Required" : "None"
      )

      // Additional custom tags
      if (this.config.additionalTags) {
        for (const [key, value] of Object.entries(this.config.additionalTags)) {
          taggable.tags.setTag(key, value)
        }
      }
    }
  }

  private capitalizeFirst(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1)
  }

  private getCostCenter(): string {
    return this.config.environment === "prod" ? "PROD-001" : "DEV-001"
  }

  private getDataClassification(node: IConstruct): string {
    // Intelligent classification based on resource type
    const nodeType = node.constructor.name
    if (
      nodeType.includes("Database") ||
      nodeType.includes("Secret") ||
      nodeType.includes("DBCluster") ||
      (nodeType.includes("Cluster") && nodeType.includes("Rds"))
    ) {
      return "Sensitive"
    } else if (nodeType.includes("Log") || nodeType.includes("Monitoring")) {
      return "Internal"
    }
    return "Public"
  }
}
