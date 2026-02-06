# Assistant Architect JSON Import Specification

This document provides a complete specification for generating valid JSON import files for the AI Studio Assistant Architect system. AI agents and external tools can use this spec to programmatically create assistants.

## Overview

The import system accepts JSON files containing assistant definitions. Each file can contain one or more assistants, but **single-assistant files are recommended** for simplicity and easier validation.

**Key behaviors:**
- All imported assistants receive `pending_approval` status regardless of the status in the JSON
- Model names are mapped to available models in the target system
- Maximum file size: 10MB

## JSON Schema Reference

### Root Structure

```json
{
  "version": "1.0",
  "exported_at": "2025-01-23T10:30:00.000Z",
  "export_source": "AI Agent Generator",
  "assistants": [...]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `version` | string | **Yes** | Must be exactly `"1.0"` |
| `exported_at` | string | No | ISO-8601 timestamp |
| `export_source` | string | No | Identifier for the generating system |
| `assistants` | array | **Yes** | Array of assistant objects |

### Assistant Object

```json
{
  "name": "My Assistant",
  "description": "Analyzes documents and provides summaries",
  "status": "approved",
  "image_path": "/images/icons/document.png",
  "is_parallel": false,
  "timeout_seconds": 300,
  "prompts": [...],
  "input_fields": [...]
}
```

| Field | Type | Required | Default | Constraints |
|-------|------|----------|---------|-------------|
| `name` | string | **Yes** | - | Min 3 characters |
| `description` | string | No | `""` | Purpose/description |
| `status` | string | No | - | **Ignored on import** (always `pending_approval`) |
| `image_path` | string | No | `null` | Path to assistant icon |
| `is_parallel` | boolean | No | `false` | Enable parallel prompt execution |
| `timeout_seconds` | number | No | `null` | Max: 900 (15 minutes) |
| `prompts` | array | **Yes** | - | 1-20 prompts required |
| `input_fields` | array | **Yes** | - | Can be empty array `[]` |

### Prompt Object

```json
{
  "name": "analyze",
  "content": "Analyze the following document:\n\n{{document_content}}",
  "system_context": "You are an expert document analyst.",
  "model_name": "gpt-4o",
  "position": 0,
  "parallel_group": null,
  "input_mapping": {
    "document_content": "{{document}}"
  },
  "timeout_seconds": 120
}
```

| Field | Type | Required | Default | Constraints |
|-------|------|----------|---------|-------------|
| `name` | string | **Yes** | - | Internal identifier |
| `content` | string | **Yes** | - | Max ~10MB, supports `{{variables}}` |
| `system_context` | string | No | `null` | System prompt prepended to request |
| `model_name` | string | **Yes** | - | Portable model ID (see [Model Mapping](#model-mapping)) |
| `position` | number | **Yes** | - | 0-based execution order |
| `parallel_group` | number | No | `null` | Group ID for parallel execution |
| `input_mapping` | object | No | `null` | Variable substitution mappings |
| `timeout_seconds` | number | No | `null` | Per-prompt timeout |

### Input Field Object

```json
{
  "name": "document",
  "label": "Upload Document",
  "field_type": "file_upload",
  "position": 0,
  "options": {
    "accept": ".pdf,.docx,.txt",
    "maxSize": 10485760
  }
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `name` | string | **Yes** | Internal identifier (used in `{{name}}` variables) |
| `label` | string | **Yes** | User-facing label |
| `field_type` | enum | **Yes** | See [Field Types](#field-types) |
| `position` | number | **Yes** | 0-based display order |
| `options` | object | No | Field-specific configuration |

## Field Types

### `short_text`
Single-line text input.

```json
{
  "name": "title",
  "label": "Document Title",
  "field_type": "short_text",
  "position": 0,
  "options": {
    "placeholder": "Enter a title...",
    "required": true,
    "maxLength": 200
  }
}
```

**Options:**
- `placeholder` (string): Placeholder text
- `required` (boolean): Whether field is required
- `maxLength` (number): Maximum character length

### `long_text`
Multi-line text area.

```json
{
  "name": "content",
  "label": "Document Content",
  "field_type": "long_text",
  "position": 1,
  "options": {
    "placeholder": "Paste content here...",
    "required": true,
    "rows": 10
  }
}
```

**Options:**
- `placeholder` (string): Placeholder text
- `required` (boolean): Whether field is required
- `rows` (number): Initial textarea height

### `select`
Single-selection dropdown.

```json
{
  "name": "output_format",
  "label": "Output Format",
  "field_type": "select",
  "position": 2,
  "options": {
    "choices": [
      { "value": "summary", "label": "Summary" },
      { "value": "bullet_points", "label": "Bullet Points" },
      { "value": "detailed", "label": "Detailed Analysis" }
    ],
    "default": "summary"
  }
}
```

**Options:**
- `choices` (array): Array of `{ value, label }` objects
- `default` (string): Default selected value

### `multi_select`
Multiple-selection checkboxes or multi-select dropdown.

```json
{
  "name": "analysis_types",
  "label": "Analysis Types",
  "field_type": "multi_select",
  "position": 3,
  "options": {
    "choices": [
      { "value": "sentiment", "label": "Sentiment Analysis" },
      { "value": "entities", "label": "Entity Extraction" },
      { "value": "keywords", "label": "Keyword Extraction" }
    ],
    "minSelections": 1,
    "maxSelections": 3
  }
}
```

**Options:**
- `choices` (array): Array of `{ value, label }` objects
- `minSelections` (number): Minimum required selections
- `maxSelections` (number): Maximum allowed selections

### `file_upload`
File upload input.

```json
{
  "name": "document",
  "label": "Upload Document",
  "field_type": "file_upload",
  "position": 4,
  "options": {
    "accept": ".pdf,.docx,.txt,.md",
    "maxSize": 10485760,
    "multiple": false
  }
}
```

**Options:**
- `accept` (string): Comma-separated file extensions or MIME types
- `maxSize` (number): Maximum file size in bytes
- `multiple` (boolean): Allow multiple file uploads

## Model Mapping

Models use portable names that are mapped to available models in the target system. The import process follows this priority:

1. **Exact match**: Model ID matches exactly
2. **Provider detection**: Based on keywords in model name:
   - `gpt`, `openai` → OpenAI provider
   - `claude` → Anthropic or Amazon Bedrock provider
   - `gemini` → Google provider
3. **Fallback**: First available active model

### Recommended Portable Model Names

| Portable Name | Description |
|---------------|-------------|
| `gpt-4o` | OpenAI GPT-4o |
| `gpt-4o-mini` | OpenAI GPT-4o Mini |
| `gpt-4-turbo` | OpenAI GPT-4 Turbo |
| `claude-3-5-sonnet` | Anthropic Claude 3.5 Sonnet |
| `claude-3-opus` | Anthropic Claude 3 Opus |
| `claude-3-haiku` | Anthropic Claude 3 Haiku |
| `gemini-1.5-pro` | Google Gemini 1.5 Pro |
| `gemini-1.5-flash` | Google Gemini 1.5 Flash |

## Variable Substitution System

Prompts support variable substitution using `{{variable_name}}` syntax.

### Input Field Variables

Reference user input directly in prompts:

```json
{
  "content": "Summarize this document:\n\n{{document_content}}\n\nFormat: {{output_format}}"
}
```

Where `document_content` and `output_format` are input field names.

### Prompt Output Variables

Reference output from previous prompts using position-based syntax:

```json
{
  "content": "Based on the previous analysis:\n\n{{prompt_0_output}}\n\nProvide recommendations."
}
```

| Variable Pattern | Description |
|------------------|-------------|
| `{{field_name}}` | Value from input field with matching name |
| `{{prompt_N_output}}` | Output from prompt at position N (0-based) |
| `{{slugified-prompt-name}}` | Output from previous prompt by slugified name (e.g., `{{facilitator-opening}}` for prompt named "Facilitator Opening") |

### Input Mapping

Use `input_mapping` for explicit variable substitution:

```json
{
  "name": "refine",
  "content": "Refine this analysis:\n\n{{analysis}}",
  "input_mapping": {
    "analysis": "{{prompt_0_output}}"
  },
  "position": 1
}
```

**Constraints:**
- Maximum 50 variable substitutions per prompt
- Variable names must match input field names, use `prompt_N_output` pattern, or use slugified prompt names

## Execution Patterns

### Sequential Execution

Default behavior where prompts execute in order by `position`.

```json
{
  "is_parallel": false,
  "prompts": [
    { "name": "step1", "position": 0, ... },
    { "name": "step2", "position": 1, ... },
    { "name": "step3", "position": 2, ... }
  ]
}
```

### Parallel Execution

Prompts with the same `parallel_group` execute concurrently.

```json
{
  "is_parallel": true,
  "prompts": [
    { "name": "analysis_a", "position": 0, "parallel_group": 1, ... },
    { "name": "analysis_b", "position": 1, "parallel_group": 1, ... },
    { "name": "synthesis", "position": 2, "parallel_group": null, ... }
  ]
}
```

In this example:
- `analysis_a` and `analysis_b` run in parallel (same `parallel_group`)
- `synthesis` runs after both complete (different/null `parallel_group`)

### Chained Execution

Sequential prompts where each uses the output of the previous.

```json
{
  "prompts": [
    {
      "name": "extract",
      "content": "Extract key points from:\n\n{{document}}",
      "position": 0
    },
    {
      "name": "analyze",
      "content": "Analyze these key points:\n\n{{prompt_0_output}}",
      "position": 1
    },
    {
      "name": "recommend",
      "content": "Based on this analysis:\n\n{{prompt_1_output}}\n\nProvide recommendations.",
      "position": 2
    }
  ]
}
```

## Complete Examples

### Example 1: Single Prompt Assistant

Simple assistant with one prompt and text input.

```json
{
  "version": "1.0",
  "exported_at": "2025-01-23T10:30:00.000Z",
  "export_source": "AI Agent",
  "assistants": [
    {
      "name": "Quick Summarizer",
      "description": "Summarizes text content into concise bullet points",
      "is_parallel": false,
      "prompts": [
        {
          "name": "summarize",
          "content": "Summarize the following text into 5-7 concise bullet points:\n\n{{text_content}}",
          "system_context": "You are an expert at creating clear, concise summaries. Focus on the most important information.",
          "model_name": "gpt-4o-mini",
          "position": 0
        }
      ],
      "input_fields": [
        {
          "name": "text_content",
          "label": "Text to Summarize",
          "field_type": "long_text",
          "position": 0,
          "options": {
            "placeholder": "Paste the text you want summarized...",
            "required": true,
            "rows": 12
          }
        }
      ]
    }
  ]
}
```

### Example 2: Multi-Step Chain

Document analysis with extraction, analysis, and recommendations.

```json
{
  "version": "1.0",
  "exported_at": "2025-01-23T10:30:00.000Z",
  "export_source": "AI Agent",
  "assistants": [
    {
      "name": "Document Analyzer",
      "description": "Analyzes documents and provides structured recommendations",
      "is_parallel": false,
      "timeout_seconds": 600,
      "prompts": [
        {
          "name": "extract",
          "content": "Extract the key information from this document:\n\n{{document_content}}\n\nProvide:\n1. Main topics\n2. Key facts and figures\n3. Important dates or deadlines\n4. Action items mentioned",
          "system_context": "You are an expert document analyst. Extract information accurately and comprehensively.",
          "model_name": "gpt-4o",
          "position": 0,
          "timeout_seconds": 180
        },
        {
          "name": "analyze",
          "content": "Based on the extracted information:\n\n{{prompt_0_output}}\n\nProvide a detailed analysis considering:\n- Significance of the key points\n- Potential implications\n- Risks or concerns\n- Opportunities identified",
          "system_context": "You are a strategic analyst. Provide insightful analysis based on the extracted information.",
          "model_name": "gpt-4o",
          "position": 1,
          "timeout_seconds": 180
        },
        {
          "name": "recommend",
          "content": "Based on the analysis:\n\n{{prompt_1_output}}\n\nFormat the output as: {{output_format}}\n\nProvide actionable recommendations prioritized by:\n1. Urgency\n2. Impact\n3. Feasibility",
          "system_context": "You are a business advisor. Provide practical, actionable recommendations.",
          "model_name": "gpt-4o",
          "position": 2,
          "timeout_seconds": 180
        }
      ],
      "input_fields": [
        {
          "name": "document_content",
          "label": "Document Content",
          "field_type": "long_text",
          "position": 0,
          "options": {
            "placeholder": "Paste the document content here...",
            "required": true,
            "rows": 15
          }
        },
        {
          "name": "output_format",
          "label": "Output Format",
          "field_type": "select",
          "position": 1,
          "options": {
            "choices": [
              { "value": "executive_summary", "label": "Executive Summary" },
              { "value": "detailed_report", "label": "Detailed Report" },
              { "value": "action_items", "label": "Action Items Only" }
            ],
            "default": "executive_summary"
          }
        }
      ]
    }
  ]
}
```

### Example 3: Parallel Analysis

Multiple analyses run in parallel, then synthesized.

```json
{
  "version": "1.0",
  "exported_at": "2025-01-23T10:30:00.000Z",
  "export_source": "AI Agent",
  "assistants": [
    {
      "name": "Multi-Perspective Analyzer",
      "description": "Analyzes content from multiple perspectives simultaneously",
      "is_parallel": true,
      "timeout_seconds": 300,
      "prompts": [
        {
          "name": "technical_analysis",
          "content": "Analyze this content from a technical perspective:\n\n{{content}}\n\nFocus on: technical accuracy, implementation feasibility, and technical risks.",
          "system_context": "You are a senior technical architect.",
          "model_name": "gpt-4o",
          "position": 0,
          "parallel_group": 1
        },
        {
          "name": "business_analysis",
          "content": "Analyze this content from a business perspective:\n\n{{content}}\n\nFocus on: business value, ROI, market implications, and competitive advantage.",
          "system_context": "You are a business strategist.",
          "model_name": "gpt-4o",
          "position": 1,
          "parallel_group": 1
        },
        {
          "name": "risk_analysis",
          "content": "Analyze this content from a risk perspective:\n\n{{content}}\n\nFocus on: potential risks, mitigation strategies, and worst-case scenarios.",
          "system_context": "You are a risk management expert.",
          "model_name": "gpt-4o",
          "position": 2,
          "parallel_group": 1
        },
        {
          "name": "synthesis",
          "content": "Synthesize these three analyses into a unified recommendation:\n\nTechnical Analysis:\n{{prompt_0_output}}\n\nBusiness Analysis:\n{{prompt_1_output}}\n\nRisk Analysis:\n{{prompt_2_output}}\n\nProvide a balanced recommendation that considers all perspectives.",
          "system_context": "You are an executive advisor who balances multiple viewpoints.",
          "model_name": "gpt-4o",
          "position": 3,
          "parallel_group": null
        }
      ],
      "input_fields": [
        {
          "name": "content",
          "label": "Content to Analyze",
          "field_type": "long_text",
          "position": 0,
          "options": {
            "placeholder": "Paste the content for multi-perspective analysis...",
            "required": true,
            "rows": 12
          }
        }
      ]
    }
  ]
}
```

### Example 4: All Field Types

Demonstrates all available input field types.

```json
{
  "version": "1.0",
  "exported_at": "2025-01-23T10:30:00.000Z",
  "export_source": "AI Agent",
  "assistants": [
    {
      "name": "Comprehensive Form Demo",
      "description": "Demonstrates all available input field types",
      "is_parallel": false,
      "prompts": [
        {
          "name": "process",
          "content": "Process this request:\n\nTitle: {{title}}\nDescription: {{description}}\nCategory: {{category}}\nFeatures: {{features}}\nFile: {{uploaded_file}}\n\nProvide a comprehensive response based on all inputs.",
          "system_context": "You are a helpful assistant.",
          "model_name": "gpt-4o",
          "position": 0
        }
      ],
      "input_fields": [
        {
          "name": "title",
          "label": "Title",
          "field_type": "short_text",
          "position": 0,
          "options": {
            "placeholder": "Enter a title...",
            "required": true,
            "maxLength": 100
          }
        },
        {
          "name": "description",
          "label": "Description",
          "field_type": "long_text",
          "position": 1,
          "options": {
            "placeholder": "Enter a detailed description...",
            "required": true,
            "rows": 6
          }
        },
        {
          "name": "category",
          "label": "Category",
          "field_type": "select",
          "position": 2,
          "options": {
            "choices": [
              { "value": "technical", "label": "Technical" },
              { "value": "business", "label": "Business" },
              { "value": "creative", "label": "Creative" }
            ],
            "default": "technical"
          }
        },
        {
          "name": "features",
          "label": "Features Required",
          "field_type": "multi_select",
          "position": 3,
          "options": {
            "choices": [
              { "value": "fast", "label": "Fast Processing" },
              { "value": "detailed", "label": "Detailed Output" },
              { "value": "summary", "label": "Include Summary" },
              { "value": "examples", "label": "Include Examples" }
            ],
            "minSelections": 1
          }
        },
        {
          "name": "uploaded_file",
          "label": "Upload Supporting Document",
          "field_type": "file_upload",
          "position": 4,
          "options": {
            "accept": ".pdf,.docx,.txt,.md",
            "maxSize": 5242880,
            "multiple": false
          }
        }
      ]
    }
  ]
}
```

## Advanced Fields (Future Use)

These fields are supported by the system but not currently included in exports:

### `repositoryIds`
Array of repository IDs for knowledge base integration.

```json
{
  "name": "Knowledge-Enhanced Assistant",
  "repositoryIds": [1, 2, 5],
  ...
}
```

### `enabledTools`
Array of enabled tool names for the assistant.

```json
{
  "name": "Tool-Enabled Assistant",
  "enabledTools": ["web_search", "code_execution"],
  ...
}
```

## Common Patterns

### Pattern: Simple Q&A

```json
{
  "prompts": [
    {
      "name": "answer",
      "content": "Answer this question:\n\n{{question}}",
      "system_context": "You are a helpful expert. Provide clear, accurate answers.",
      "model_name": "gpt-4o-mini",
      "position": 0
    }
  ],
  "input_fields": [
    {
      "name": "question",
      "label": "Your Question",
      "field_type": "long_text",
      "position": 0
    }
  ]
}
```

### Pattern: Transform with Options

```json
{
  "prompts": [
    {
      "name": "transform",
      "content": "Transform this content to {{target_style}} style:\n\n{{content}}",
      "model_name": "gpt-4o",
      "position": 0
    }
  ],
  "input_fields": [
    {
      "name": "content",
      "label": "Content",
      "field_type": "long_text",
      "position": 0
    },
    {
      "name": "target_style",
      "label": "Target Style",
      "field_type": "select",
      "position": 1,
      "options": {
        "choices": [
          { "value": "formal", "label": "Formal" },
          { "value": "casual", "label": "Casual" },
          { "value": "technical", "label": "Technical" }
        ]
      }
    }
  ]
}
```

### Pattern: Review and Improve

```json
{
  "prompts": [
    {
      "name": "review",
      "content": "Review this content for issues:\n\n{{content}}",
      "position": 0
    },
    {
      "name": "improve",
      "content": "Based on this review:\n\n{{prompt_0_output}}\n\nProvide an improved version of:\n\n{{content}}",
      "position": 1
    }
  ]
}
```

## Validation Checklist

Before importing, verify:

### Structure
- [ ] `version` is exactly `"1.0"`
- [ ] `assistants` is a non-empty array
- [ ] Each assistant has a `name` (min 3 characters)
- [ ] Each assistant has a `prompts` array (1-20 prompts)
- [ ] Each assistant has an `input_fields` array (can be empty)

### Prompts
- [ ] Each prompt has `name`, `content`, `model_name`, `position`
- [ ] `position` values are sequential starting from 0
- [ ] `model_name` uses portable model identifiers
- [ ] Variables (`{{...}}`) reference valid input fields or prompt outputs
- [ ] If using parallel execution, `is_parallel` is `true` and `parallel_group` values are set

### Input Fields
- [ ] Each field has `name`, `label`, `field_type`, `position`
- [ ] `field_type` is one of: `short_text`, `long_text`, `select`, `multi_select`, `file_upload`
- [ ] `position` values are sequential starting from 0
- [ ] Select/multi-select fields have `options.choices` array
- [ ] Field `name` values match variable references in prompts

### Variables
- [ ] Input field variables: `{{field_name}}` matches an input field `name`
- [ ] Prompt output variables: `{{prompt_N_output}}` where N < current prompt position
- [ ] No more than 50 substitutions per prompt

## Error Reference

| Error | Cause | Fix |
|-------|-------|-----|
| `Invalid file format` | Not valid JSON or missing required structure | Ensure valid JSON with required fields |
| `Missing version information` | No `version` field | Add `"version": "1.0"` |
| `Unsupported version: X.X` | Version other than 1.0 | Use `"version": "1.0"` |
| `Missing or invalid assistants array` | `assistants` not an array | Ensure `assistants` is an array |
| `Invalid assistant: missing name` | Assistant without `name` field | Add `name` to each assistant |
| `missing prompts array` | Assistant without `prompts` array | Add `prompts` array (min 1 prompt) |
| `missing input_fields array` | Assistant without `input_fields` | Add `input_fields` array (can be `[]`) |
| `No model mapping found` | Model name couldn't be mapped | Use portable model names listed above |
| `File too large` | File exceeds 10MB | Reduce file size or split into multiple files |

## Best Practices

1. **Use portable model names** - Stick to the recommended model names for maximum compatibility
2. **Keep prompts focused** - Each prompt should have a single, clear purpose
3. **Use descriptive names** - Field and prompt names should clearly indicate their purpose
4. **Test variable references** - Ensure all `{{variable}}` references are valid before import
5. **Consider timeouts** - Set appropriate timeouts for complex or long-running prompts
6. **Provide system context** - Use `system_context` to set behavior expectations for the model
7. **Order fields logically** - Set `position` values to present fields in a logical order for users
