# AI Model JSON Import Guide

## Overview

This guide provides instructions for creating fully-populated JSON files to import AI models into the system. This process is designed to ensure accurate, up-to-date model information with K-12 appropriate descriptions.

## Critical Rules

### 1. **ALWAYS Search the Web - Never Use Cached Knowledge**

**⚠️ IMPORTANT:** AI model information changes frequently (pricing, capabilities, context windows, etc.). You MUST:

- ✅ Search the web for current information at the time of import
- ✅ Check official provider documentation (OpenAI, Anthropic, Google, etc.)
- ✅ Verify pricing from official pricing pages
- ✅ Confirm current model capabilities and limits
- ❌ NEVER rely on training data or cached knowledge
- ❌ NEVER guess at pricing or capabilities

**Example Search Queries:**
- "GPT-4 Turbo pricing January 2025"
- "Claude 3.5 Sonnet API documentation"
- "Gemini Pro context window 2025"
- "OpenAI GPT-4o capabilities"

### 2. **K-12 Appropriate Descriptions**

Descriptions should be:
- **Clear and simple** - Avoid technical jargon
- **Educational context** - Explain how it helps students/teachers
- **Age-appropriate** - Suitable for K-12 environment
- **Concise** - 1-2 sentences maximum

**Good Examples:**
- ✅ "Fast and cost-effective model ideal for quick questions and routine assignments"
- ✅ "Most capable model with advanced reasoning, perfect for complex essay feedback and research assistance"
- ✅ "Balanced model with vision capabilities, great for analyzing images and diagrams in science projects"

**Bad Examples:**
- ❌ "GPT-4 with 128K context window and function calling"
- ❌ "Multimodal transformer model with RLHF training"
- ❌ "High-performance LLM for production workloads"

## JSON Schema

### Required Fields

```json
{
  "name": "GPT-4 Turbo",              // Display name (user-facing)
  "modelId": "gpt-4-turbo",           // API identifier (exact match to provider)
  "provider": "openai"                // One of: openai, azure, amazon-bedrock, google, google-vertex
}
```

### Recommended Fields

```json
{
  "description": "Most capable GPT-4 model with extended context, ideal for complex assignments and detailed feedback",
  "maxTokens": 128000,                // Maximum context window
  "active": true,                     // Enable immediately
  "nexusEnabled": true,               // Available in Nexus chat
  "architectEnabled": true,           // Available in Assistant Architect
  "capabilities": [                   // Array of capability strings
    "chat",
    "function_calling",
    "json_mode",
    "image_analysis"
  ],
  "inputCostPer1kTokens": "0.01",    // Cost per 1K input tokens (USD)
  "outputCostPer1kTokens": "0.03",   // Cost per 1K output tokens (USD)
  "cachedInputCostPer1kTokens": "0.0025"  // Cost for cached input (if supported)
}
```

### Optional Fields

```json
{
  "allowedRoles": ["administrator", "staff"]  // Restrict by role (null = all roles)
}
```

## Standard Capabilities

Use these standard capability values for consistency:

### Core Capabilities
- `"chat"` - General conversational ability
- `"function_calling"` - Can call external functions/tools
- `"json_mode"` - Structured JSON output
- `"streaming"` - Supports streaming responses

### Advanced Capabilities
- `"image_analysis"` - Can analyze/understand images
- `"image_generation"` - Can create images
- `"file_analysis"` - Can process uploaded documents
- `"web_search"` - Can search the internet
- `"code_interpreter"` - Can execute code
- `"code_execution"` - Can run code in sandbox
- `"reasoning"` - Extended reasoning (like o1)
- `"thinking"` - Shows reasoning process
- `"canvas"` - Supports canvas/artifacts
- `"computer_use"` - Can interact with computer interfaces

## Valid Provider Values

Must be one of:
- `"openai"` - OpenAI (GPT models)
- `"azure"` - Azure OpenAI
- `"amazon-bedrock"` - AWS Bedrock (Claude, etc.)
- `"google"` - Google AI (Gemini)
- `"google-vertex"` - Google Vertex AI

## Step-by-Step Process

### Step 1: Identify the Model

Get the exact model identifier from the provider:
- OpenAI: `gpt-4-turbo`, `gpt-4o`, `gpt-4o-mini`
- Anthropic: `claude-3-5-sonnet-20241022`, `claude-3-opus-20240229`
- Google: `gemini-1.5-pro`, `gemini-1.5-flash`

### Step 2: Search for Current Information

**Required searches:**
1. Official documentation page
2. Pricing page (current rates)
3. Capabilities/features list
4. Context window/limits

**Sources to check:**
- OpenAI: https://platform.openai.com/docs/models
- Anthropic: https://docs.anthropic.com/claude/docs
- Google: https://ai.google.dev/models/gemini
- Pricing pages (search for "[provider] API pricing 2025")

### Step 3: Gather Information

**Document:**
- ✅ Exact model ID (e.g., `gpt-4-turbo-2024-04-09`)
- ✅ Display name (e.g., "GPT-4 Turbo")
- ✅ Maximum tokens (context window)
- ✅ Input pricing per 1K tokens
- ✅ Output pricing per 1K tokens
- ✅ Cached input pricing (if available)
- ✅ Capabilities (vision, tools, JSON mode, etc.)
- ✅ Special features (reasoning, streaming, etc.)

### Step 4: Write K-12 Description

**Template:** "[Model tier/type] with [key feature], [educational use case]"

**Examples by use case:**
- **Budget-friendly:** "Cost-effective model perfect for quick questions, grammar checks, and routine assignments"
- **Balanced:** "Versatile model with vision support, great for analyzing diagrams and providing detailed explanations"
- **Premium:** "Most capable model with advanced reasoning, ideal for complex research projects and essay feedback"
- **Specialized:** "Fast model optimized for code, excellent for computer science classes and programming help"
- **Reasoning:** "Advanced reasoning model that shows its thinking process, perfect for teaching problem-solving skills"

### Step 5: Determine Capabilities

**Check the official docs for:**
- Text generation (all models have this)
- Vision/image analysis (`image_analysis`)
- Function calling/tools (`function_calling`)
- JSON mode (`json_mode`)
- Code execution (`code_interpreter` or `code_execution`)
- Web search (`web_search`)
- Extended reasoning (`reasoning`, `thinking`)

### Step 6: Set Access Levels

**Default settings:**
```json
{
  "active": true,              // Enable for use
  "nexusEnabled": true,        // Available in Nexus/Compare
  "architectEnabled": true,    // Available in Assistant Architect
  "allowedRoles": null         // All roles can access
}
```

**Restricted settings** (expensive or experimental models):
```json
{
  "active": true,
  "nexusEnabled": true,
  "architectEnabled": false,   // Not in Assistant Architect
  "allowedRoles": ["administrator", "staff"]  // Teachers only
}
```

### Step 7: Build the JSON

Combine all gathered information into the JSON structure.

## Complete Examples

### Example 1: OpenAI GPT-4o (Current as of import date)

```json
{
  "name": "GPT-4o",
  "modelId": "gpt-4o",
  "provider": "openai",
  "description": "OpenAI's most advanced model with vision and voice capabilities, perfect for analyzing images in science projects and providing detailed explanations",
  "capabilities": [
    "chat",
    "function_calling",
    "json_mode",
    "image_analysis",
    "streaming"
  ],
  "maxTokens": 128000,
  "active": true,
  "nexusEnabled": true,
  "architectEnabled": true,
  "inputCostPer1kTokens": "0.0025",
  "outputCostPer1kTokens": "0.01",
  "cachedInputCostPer1kTokens": "0.00125"
}
```

### Example 2: Anthropic Claude 3.5 Sonnet

```json
{
  "name": "Claude 3.5 Sonnet",
  "modelId": "claude-3-5-sonnet-20241022",
  "provider": "amazon-bedrock",
  "description": "Anthropic's most intelligent model with exceptional writing and analysis skills, ideal for essay feedback and creative writing projects",
  "capabilities": [
    "chat",
    "function_calling",
    "json_mode",
    "image_analysis",
    "streaming",
    "thinking"
  ],
  "maxTokens": 200000,
  "active": true,
  "nexusEnabled": true,
  "architectEnabled": true,
  "inputCostPer1kTokens": "0.003",
  "outputCostPer1kTokens": "0.015",
  "cachedInputCostPer1kTokens": "0.0003"
}
```

### Example 3: Google Gemini 1.5 Flash (Budget-friendly)

```json
{
  "name": "Gemini 1.5 Flash",
  "modelId": "gemini-1.5-flash",
  "provider": "google",
  "description": "Fast and cost-effective model with vision support, great for quick questions and routine homework assistance",
  "capabilities": [
    "chat",
    "function_calling",
    "json_mode",
    "image_analysis",
    "streaming"
  ],
  "maxTokens": 1000000,
  "active": true,
  "nexusEnabled": true,
  "architectEnabled": true,
  "inputCostPer1kTokens": "0.000075",
  "outputCostPer1kTokens": "0.0003"
}
```

### Example 4: OpenAI o1-preview (Reasoning Model - Restricted)

```json
{
  "name": "GPT-o1 Preview",
  "modelId": "o1-preview",
  "provider": "openai",
  "description": "Advanced reasoning model that shows its thinking process step-by-step, perfect for teaching complex problem-solving in math and science",
  "capabilities": [
    "chat",
    "reasoning",
    "thinking"
  ],
  "maxTokens": 128000,
  "active": true,
  "nexusEnabled": true,
  "architectEnabled": false,
  "allowedRoles": ["administrator", "staff"],
  "inputCostPer1kTokens": "0.015",
  "outputCostPer1kTokens": "0.06"
}
```

### Example 5: Multiple Models Import (Array)

```json
[
  {
    "name": "GPT-4o Mini",
    "modelId": "gpt-4o-mini",
    "provider": "openai",
    "description": "Smaller, faster version of GPT-4o, ideal for quick grammar checks and simple questions",
    "capabilities": ["chat", "function_calling", "json_mode", "streaming"],
    "maxTokens": 128000,
    "active": true,
    "nexusEnabled": true,
    "architectEnabled": true,
    "inputCostPer1kTokens": "0.00015",
    "outputCostPer1kTokens": "0.0006"
  },
  {
    "name": "GPT-4 Turbo",
    "modelId": "gpt-4-turbo",
    "provider": "openai",
    "description": "High-performance model with vision capabilities, excellent for detailed essay analysis and research projects",
    "capabilities": ["chat", "function_calling", "json_mode", "image_analysis", "streaming"],
    "maxTokens": 128000,
    "active": true,
    "nexusEnabled": true,
    "architectEnabled": true,
    "inputCostPer1kTokens": "0.01",
    "outputCostPer1kTokens": "0.03"
  }
]
```

## Import Process

### 1. Copy the JSON
Copy your completed JSON to clipboard

### 2. Navigate to Admin Panel
Go to: **Admin → AI Models**

### 3. Click Import JSON Button
Located in the top-right header area

### 4. Paste JSON
Paste into the textarea

### 5. Review Validation
Check for any validation errors displayed inline

### 6. Click Import
System will show: "Created: X, Updated: Y"

### 7. Verify
Check the models table to confirm successful import

## Troubleshooting

### Common Validation Errors

**"Invalid provider 'X'"**
- Use exact values: `openai`, `azure`, `amazon-bedrock`, `google`, `google-vertex`

**"modelId must be unique"**
- Model already exists - it will be updated, not created

**"maxTokens must be an integer"**
- Remove quotes: `128000` not `"128000"`

**"inputCostPer1kTokens must be a number"**
- Can be string or number: `"0.01"` or `0.01` both work

**"Duplicate modelId: X"**
- Same modelId appears multiple times in your JSON array

## Best Practices

### 1. Verify Before Import
- Double-check pricing (it changes frequently)
- Confirm capabilities from official docs
- Test description clarity with non-technical colleague

### 2. Update Existing Models
- Import will UPDATE models with matching `modelId`
- Use this to refresh pricing when providers announce changes
- Update descriptions as capabilities improve

### 3. Conservative Access
- Start with `allowedRoles: ["administrator"]` for expensive models
- Expand access after monitoring costs
- Use `active: false` to add models for future activation

### 4. Document Your Source
- Keep a note of where you found the information
- Include date of research
- Saves time when verifying later

## Template Workflow for Adding New Models

**When a new model is announced:**

1. **Search:** "[Model name] API documentation [current month/year]"
2. **Search:** "[Provider] API pricing [current month/year]"
3. **Gather:** Model ID, pricing, context window, capabilities
4. **Write:** K-12 appropriate description (education-focused)
5. **Build:** JSON using examples above as template
6. **Verify:** All required fields present, pricing accurate
7. **Import:** Paste into JSON Import dialog
8. **Test:** Try the model in Nexus to verify it works

---

**Last Updated:** January 2025

**Note:** This guide assumes you're using Claude Code or similar AI assistant with web search capabilities. Always search for current information - never rely on cached knowledge for pricing or capabilities.
