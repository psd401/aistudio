'use client';

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { IconPlus, IconEdit, IconTrash, IconChevronRight } from '@tabler/icons-react';
import type { SelectAiModel, NexusCapabilities, ProviderMetadata } from '@/types';
import { MultiSelect, type MultiSelectOption } from '@/components/ui/multi-select';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  SortingState,
  useReactTable,
  Column,
} from '@tanstack/react-table';
import { IconChevronDown, IconChevronUp, IconSelector } from '@tabler/icons-react';

// Type definitions for API responses
interface RoleData {
  id: string;
  name: string;
  description?: string;
}


interface ModelFormProps {
  modelData: ModelFormData;
  setModelData: (data: ModelFormData) => void;
  onSubmit: () => void;
  onCancel: () => void;
  isEditing: boolean;
  roleOptions: MultiSelectOption[];
  roleLoading?: boolean;
}

const ModelForm = React.memo(function ModelForm({ 
  modelData, 
  setModelData, 
  onSubmit, 
  onCancel, 
  isEditing,
  roleOptions,
  roleLoading = false
}: ModelFormProps) {
  const [pricingOpen, setPricingOpen] = useState(false);
  const [performanceOpen, setPerformanceOpen] = useState(false);
  const [nexusCapabilitiesOpen, setNexusCapabilitiesOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [jsonError, setJsonError] = useState<string | null>(null);
  
  // Basic field handlers
  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => 
    setModelData({ ...modelData, name: e.target.value });
    
  const handleProviderChange = (value: string) => 
    setModelData({ ...modelData, provider: value });
    
  const handleModelIdChange = (e: React.ChangeEvent<HTMLInputElement>) => 
    setModelData({ ...modelData, modelId: e.target.value });
    
  const handleDescriptionChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => 
    setModelData({ ...modelData, description: e.target.value });
    
  const handleRolesChange = (roles: string[]) =>
    setModelData({ ...modelData, allowedRoles: roles });
    
  const handleCapabilitiesListChange = (capabilities: string[]) =>
    setModelData({ ...modelData, capabilitiesList: capabilities });
    
  const handleMaxTokensChange = (e: React.ChangeEvent<HTMLInputElement>) => 
    setModelData({ ...modelData, maxTokens: Number.parseInt(e.target.value) || 4096 });
    
  const handleActiveChange = (checked: boolean) => 
    setModelData({ ...modelData, active: checked });
    
  const handleChatEnabledChange = (checked: boolean) => 
    setModelData({ ...modelData, chatEnabled: checked });

  // Pricing field handlers with validation
  const handleInputCostChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (!value) {
      setModelData({ ...modelData, inputCostPer1kTokens: null });
      return;
    }
    const parsed = Number.parseFloat(value);
    if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 1000) {
      setModelData({ ...modelData, inputCostPer1kTokens: parsed });
    }
  };
    
  const handleOutputCostChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (!value) {
      setModelData({ ...modelData, outputCostPer1kTokens: null });
      return;
    }
    const parsed = Number.parseFloat(value);
    if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 1000) {
      setModelData({ ...modelData, outputCostPer1kTokens: parsed });
    }
  };
    
  const handleCachedInputCostChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (!value) {
      setModelData({ ...modelData, cachedInputCostPer1kTokens: null });
      return;
    }
    const parsed = Number.parseFloat(value);
    if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 1000) {
      setModelData({ ...modelData, cachedInputCostPer1kTokens: parsed });
    }
  };

  // Performance field handlers with validation
  const handleLatencyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (!value) {
      setModelData({ ...modelData, averageLatencyMs: null });
      return;
    }
    const parsed = Number.parseInt(value);
    if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 30000) {
      setModelData({ ...modelData, averageLatencyMs: parsed });
    }
  };
    
  const handleConcurrencyChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (!value) {
      setModelData({ ...modelData, maxConcurrency: null });
      return;
    }
    const parsed = Number.parseInt(value);
    if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= 1000) {
      setModelData({ ...modelData, maxConcurrency: parsed });
    }
  };
    
  const handleBatchingChange = (checked: boolean) => 
    setModelData({ ...modelData, supportsBatching: checked });

  // Nexus capabilities handler
  const handleNexusCapabilityChange = (capability: string, checked: boolean) => {
    setModelData({ 
      ...modelData, 
      nexusCapabilities: { 
        ...modelData.nexusCapabilities, 
        [capability]: checked 
      } 
    });
  };

  // Provider metadata handler with validation
  const handleProviderMetadataChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value.trim();
    
    // Allow empty input
    if (!value) {
      setModelData({ ...modelData, providerMetadata: {} });
      setJsonError(null);
      return;
    }
    
    try {
      const parsed = JSON.parse(value);
      
      // Validate that it's an object (not array or primitive)
      if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
        throw new Error('Must be a valid JSON object');
      }
      
      // Basic security validation - reject common dangerous patterns
      const jsonString = JSON.stringify(parsed);
      if (jsonString.includes('__proto__') || jsonString.includes('constructor') || jsonString.includes('prototype')) {
        throw new Error('Invalid JSON: contains prohibited properties');
      }
      
      setModelData({ ...modelData, providerMetadata: parsed as ProviderMetadata });
      setJsonError(null);
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : 'Invalid JSON format');
      // Don't update the model data on error, preserving user input
    }
  };

  const nexusCapabilityKeys = Object.keys(modelData.nexusCapabilities || {});
    
  return (
    <div className="space-y-6 max-h-[70vh] overflow-y-auto">
      {/* Basic Information Section */}
      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Basic Information</h3>
        
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <label htmlFor="model-name" className="text-sm font-medium">Name</label>
            <Input
              id="model-name"
              value={modelData.name}
              onChange={handleNameChange}
              required
            />
          </div>

          <div className="space-y-2">
            <div className="text-sm font-medium" aria-label="Provider">Provider</div>
            <Select
              value={modelData.provider || ''}
              onValueChange={handleProviderChange}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a provider" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai">OpenAI</SelectItem>
                <SelectItem value="azure">Azure OpenAI</SelectItem>
                <SelectItem value="amazon-bedrock">Amazon Bedrock</SelectItem>
                <SelectItem value="google">Google AI</SelectItem>
                <SelectItem value="google-vertex">Google Vertex AI</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-2">
          <label htmlFor="model-id" className="text-sm font-medium">Model ID</label>
          <Input
            id="model-id"
            value={modelData.modelId}
            onChange={handleModelIdChange}
            required
          />
        </div>

        <div className="space-y-2">
          <label htmlFor="model-description" className="text-sm font-medium">Description</label>
          <Textarea
            id="model-description"
            value={modelData.description || ''}
            onChange={handleDescriptionChange}
          />
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium" aria-label="General Capabilities">General Capabilities</div>
          <MultiSelect
            options={capabilityOptions}
            value={modelData.capabilitiesList}
            onChange={handleCapabilitiesListChange}
            placeholder="Select capabilities"
            allowCustom={true}
            customPlaceholder="Add custom capability..."
            className="w-full"
          />
          <p className="text-xs text-muted-foreground">
            Select model capabilities or add custom ones
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <label htmlFor="model-max-tokens" className="text-sm font-medium">Max Tokens</label>
            <Input
              id="model-max-tokens"
              type="number"
              value={modelData.maxTokens?.toString() || '4096'}
              onChange={handleMaxTokensChange}
            />
          </div>
        </div>

        <div className="flex items-center space-x-4">
          <div className="flex items-center space-x-2">
            <Switch
              id="model-active"
              checked={modelData.active}
              onCheckedChange={handleActiveChange}
            />
            <label htmlFor="model-active" className="text-sm font-medium">Active</label>
          </div>
          <div className="flex items-center space-x-2">
            <Switch
              id="model-chat-enabled"
              checked={modelData.chatEnabled}
              onCheckedChange={handleChatEnabledChange}
            />
            <label htmlFor="model-chat-enabled" className="text-sm font-medium">Chat Enabled</label>
          </div>
        </div>
      </div>

      {/* Pricing Section */}
      <Collapsible open={pricingOpen} onOpenChange={setPricingOpen}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" className="flex items-center space-x-2 p-0 h-auto">
            <IconChevronRight 
              size={16} 
              className={`transition-transform ${pricingOpen ? 'rotate-90' : ''}`} 
            />
            <span className="text-lg font-semibold">Pricing</span>
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-4 mt-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <label htmlFor="model-input-cost" className="text-sm font-medium">Input Cost per 1K tokens ($)</label>
              <Input
                id="model-input-cost"
                type="number"
                step="0.000001"
                value={modelData.inputCostPer1kTokens?.toString() || ''}
                onChange={handleInputCostChange}
                placeholder="0.000000"
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="model-output-cost" className="text-sm font-medium">Output Cost per 1K tokens ($)</label>
              <Input
                id="model-output-cost"
                type="number"
                step="0.000001"
                value={modelData.outputCostPer1kTokens?.toString() || ''}
                onChange={handleOutputCostChange}
                placeholder="0.000000"
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="model-cached-input-cost" className="text-sm font-medium">Cached Input Cost per 1K tokens ($)</label>
              <Input
                id="model-cached-input-cost"
                type="number"
                step="0.000001"
                value={modelData.cachedInputCostPer1kTokens?.toString() || ''}
                onChange={handleCachedInputCostChange}
                placeholder="0.000000"
              />
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Performance Section */}
      <Collapsible open={performanceOpen} onOpenChange={setPerformanceOpen}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" className="flex items-center space-x-2 p-0 h-auto">
            <IconChevronRight 
              size={16} 
              className={`transition-transform ${performanceOpen ? 'rotate-90' : ''}`} 
            />
            <span className="text-lg font-semibold">Performance</span>
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-4 mt-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <label htmlFor="model-latency" className="text-sm font-medium">Average Latency (ms)</label>
              <Input
                id="model-latency"
                type="number"
                value={modelData.averageLatencyMs?.toString() || ''}
                onChange={handleLatencyChange}
                placeholder="1500"
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="model-concurrency" className="text-sm font-medium">Max Concurrency</label>
              <Input
                id="model-concurrency"
                type="number"
                min="1"
                max="100"
                value={modelData.maxConcurrency?.toString() || ''}
                onChange={handleConcurrencyChange}
                placeholder="10"
              />
            </div>
            <div className="flex items-center space-x-2 pt-6">
              <Switch
                id="model-batching"
                checked={modelData.supportsBatching}
                onCheckedChange={handleBatchingChange}
              />
              <label htmlFor="model-batching" className="text-sm font-medium">Supports Batching</label>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Nexus Capabilities Section */}
      <Collapsible open={nexusCapabilitiesOpen} onOpenChange={setNexusCapabilitiesOpen}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" className="flex items-center space-x-2 p-0 h-auto">
            <IconChevronRight 
              size={16} 
              className={`transition-transform ${nexusCapabilitiesOpen ? 'rotate-90' : ''}`} 
            />
            <span className="text-lg font-semibold">Nexus Capabilities</span>
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-4 mt-4">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {nexusCapabilityKeys.map(capability => (
              <div key={capability} className="flex items-center space-x-2">
                <Switch
                  checked={modelData.nexusCapabilities[capability] || false}
                  onCheckedChange={(checked) => handleNexusCapabilityChange(capability, checked)}
                />
                <label className="text-sm font-medium capitalize">
                  {capability.replace(/([A-Z])/g, ' $1').trim()}
                </label>
              </div>
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Access Control Section */}
      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Access Control</h3>

        <div className="space-y-2">
          <div className="text-sm font-medium" aria-label="Allowed Roles">
            Allowed Roles
            {roleLoading && (
              <span className="ml-2 text-xs text-muted-foreground">(Loading...)</span>
            )}
          </div>
          <MultiSelect
            options={roleOptions}
            value={modelData.allowedRoles}
            onChange={handleRolesChange}
            placeholder={roleLoading ? "Loading roles..." : "All roles (unrestricted)"}
            disabled={roleLoading}
            className="w-full"
          />
          <p className="text-xs text-muted-foreground">
            Leave empty to allow access for all roles
          </p>
        </div>
      </div>

      {/* Advanced Section */}
      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" className="flex items-center space-x-2 p-0 h-auto">
            <IconChevronRight 
              size={16} 
              className={`transition-transform ${advancedOpen ? 'rotate-90' : ''}`} 
            />
            <span className="text-lg font-semibold">Advanced</span>
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-4 mt-4">
          <div className="space-y-2">
            <label htmlFor="model-provider-metadata" className="text-sm font-medium">Provider Metadata (JSON)</label>
            <Textarea
              id="model-provider-metadata"
              value={JSON.stringify(modelData.providerMetadata, null, 2)}
              onChange={handleProviderMetadataChange}
              className={`font-mono text-xs ${jsonError ? 'border-red-500' : ''}`}
              rows={6}
              placeholder='{"max_context_length": 128000, "supports_streaming": true}'
            />
            {jsonError && (
              <p className="text-xs text-red-600">
                {jsonError}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Provider-specific configuration and metadata
            </p>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <div className="flex space-x-2 pt-4">
        <Button onClick={onSubmit}>{isEditing ? 'Update' : 'Add'} Model</Button>
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
});

interface AiModelsTableProps {
  models: SelectAiModel[];
  onAddModel?: (model: Omit<SelectAiModel, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>;
  onUpdateModel?: (modelId: number, updates: Partial<SelectAiModel>) => Promise<void>;
  onDeleteModel?: (modelId: number) => Promise<void>;
}

type ModelFormData = {
  name: string;
  provider: string;
  modelId: string;
  description: string;
  capabilities: string;
  maxTokens: number;
  active: boolean;
  chatEnabled: boolean;
  allowedRoles: string[];
  capabilitiesList: string[];
  // Pricing fields
  inputCostPer1kTokens: number | null;
  outputCostPer1kTokens: number | null;
  cachedInputCostPer1kTokens: number | null;
  // Performance fields
  averageLatencyMs: number | null;
  maxConcurrency: number | null;
  supportsBatching: boolean;
  // Capability/Metadata fields
  nexusCapabilities: NexusCapabilities;
  providerMetadata: ProviderMetadata;
};

const DEFAULT_NEXUS_CAPABILITIES: NexusCapabilities = {
  canvas: false,
  thinking: false,
  artifacts: false,
  grounding: false,
  reasoning: false,
  webSearch: false,
  computerUse: false,
  responsesAPI: false,
  codeExecution: false,
  promptCaching: false,
  contextCaching: false,
  workspaceTools: false,
  codeInterpreter: false
} as const;

const emptyModel: ModelFormData = {
  name: '',
  provider: '',
  modelId: '',
  description: '',
  capabilities: '',
  maxTokens: 4096,
  active: true,
  chatEnabled: false,
  allowedRoles: [],
  capabilitiesList: [],
  // Pricing fields
  inputCostPer1kTokens: null,
  outputCostPer1kTokens: null,
  cachedInputCostPer1kTokens: null,
  // Performance fields
  averageLatencyMs: null,
  maxConcurrency: null,
  supportsBatching: false,
  // Capability/Metadata fields
  nexusCapabilities: { ...DEFAULT_NEXUS_CAPABILITIES },
  providerMetadata: {}
};

// Fallback role options used when API fails
const fallbackRoleOptions: MultiSelectOption[] = [
  { value: 'administrator', label: 'Administrator', description: 'Full system access' },
  { value: 'staff', label: 'Staff', description: 'Staff member access' },
  { value: 'student', label: 'Student', description: 'Basic user access' },
];

// Common AI model capabilities
const capabilityOptions: MultiSelectOption[] = [
  { value: 'chat', label: 'Chat', description: 'General conversation' },
  { value: 'code_interpreter', label: 'Code Interpreter', description: 'Execute code' },
  { value: 'web_search', label: 'Web Search', description: 'Search the internet' },
  { value: 'image_generation', label: 'Image Generation', description: 'Create images' },
  { value: 'image_analysis', label: 'Image Analysis', description: 'Analyze images' },
  { value: 'file_analysis', label: 'File Analysis', description: 'Process documents' },
  { value: 'function_calling', label: 'Function Calling', description: 'Use tools/functions' },
  { value: 'json_mode', label: 'JSON Mode', description: 'Structured JSON output' },
];

export const AiModelsTable = React.memo(function AiModelsTable({ 
  models, 
  onAddModel, 
  onDeleteModel, 
  onUpdateModel 
}: AiModelsTableProps) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingModel, setEditingModel] = useState<SelectAiModel | null>(null);
  const [modelData, setModelData] = useState<ModelFormData>(emptyModel);
  const [sorting, setSorting] = useState<SortingState>([]);
  
  // Dynamic role loading state
  const [roleOptions, setRoleOptions] = useState<MultiSelectOption[]>(fallbackRoleOptions);
  const [roleLoading, setRoleLoading] = useState(true);

  // Fetch roles from API on component mount
  useEffect(() => {
    let isCancelled = false;
    const controller = new AbortController();
    
    const fetchRoles = async () => {
      try {
        if (isCancelled) return;
        setRoleLoading(true);
        
        // Add timeout to prevent indefinite hanging
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout
        
        const response = await fetch('/api/admin/roles', {
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        // Handle authentication failures silently
        if (response.status === 401 || response.status === 403) {
          // User shouldn't be here if not authenticated, fall back silently
          if (!isCancelled) {
            setRoleOptions(fallbackRoleOptions);
          }
          return;
        }
        
        if (!response.ok) {
          // Generic network error, fall back silently
          if (!isCancelled) {
            setRoleOptions(fallbackRoleOptions);
          }
          return;
        }
        
        const data = await response.json();
        
        if (!data.isSuccess) {
          // API error, fall back silently
          if (!isCancelled) {
            setRoleOptions(fallbackRoleOptions);
          }
          return;
        }
        
        // Validate API response structure for type safety
        if (!Array.isArray(data.data)) {
          // Invalid response format, fall back silently
          if (!isCancelled) {
            setRoleOptions(fallbackRoleOptions);
          }
          return;
        }
        
        // Transform role data to MultiSelectOption format with type validation
        const dynamicRoleOptions: MultiSelectOption[] = data.data
          .filter((role: unknown): role is RoleData => {
            return role != null && 
                   typeof role === 'object' && 
                   'id' in role && 
                   'name' in role &&
                   typeof (role as RoleData).name === 'string';
          })
          .map((role: RoleData) => ({
            value: role.name,
            label: role.name,
            description: role.description || 'User role'
          }));
        
        if (!isCancelled) {
          setRoleOptions(dynamicRoleOptions.length > 0 ? dynamicRoleOptions : fallbackRoleOptions);
        }
      } catch (error) {
        // Silent error handling per CLAUDE.md standards - no console logging
        // Fall back to hardcoded roles for graceful degradation
        if (!isCancelled && (error as Error).name !== 'AbortError') {
          setRoleOptions(fallbackRoleOptions);
        }
      } finally {
        if (!isCancelled) {
          setRoleLoading(false);
        }
      }
    };

    fetchRoles();
    
    // Cleanup function to prevent memory leaks
    return () => {
      isCancelled = true;
      controller.abort();
    };
  }, []);
  
  // Memoized column header component to prevent recreation on each render
  const SortableColumnHeader = useCallback(({
    column,
    title,
    className = ""
  }: {
    column: Column<SelectAiModel, unknown>;
    title: string;
    className?: string;
  }) => (
    <Button
      variant="ghost"
      onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
      className={`hover:bg-transparent px-0 ${className}`}
    >
      {title}
      {column.getIsSorted() === "asc" ? (
        <IconChevronUp className="ml-2 h-4 w-4" />
      ) : column.getIsSorted() === "desc" ? (
        <IconChevronDown className="ml-2 h-4 w-4" />
      ) : (
        <IconSelector className="ml-2 h-4 w-4" />
      )}
    </Button>
  ), []);

  // Event handler for toggling active status
  const handleActiveToggle = useCallback((id: number, checked: boolean) => {
    onUpdateModel?.(id, { active: checked });
  }, [onUpdateModel]);

  // Event handler for toggling chat enabled status

  // Event handler for edit button
  const handleEditClick = useCallback((model: SelectAiModel) => {
    setEditingModel(model);
    
    // Parse capabilities if it's a JSON string
    let capabilitiesList: string[] = [];
    if (model.capabilities) {
      try {
        const parsed = typeof model.capabilities === 'string' 
          ? JSON.parse(model.capabilities) 
          : model.capabilities;
        if (Array.isArray(parsed)) {
          capabilitiesList = parsed;
        } else {
          // If it's not an array but valid JSON (e.g., an object), 
          // show it as a custom item that can be cleared
          capabilitiesList = [JSON.stringify(parsed)];
        }
      } catch {
        // If not valid JSON, show the raw string as a custom item
        if (typeof model.capabilities === 'string' && model.capabilities.trim()) {
          capabilitiesList = [model.capabilities];
        } else {
          capabilitiesList = [];
        }
      }
    }
    
    // Parse allowed roles if it's a JSON string
    let allowedRoles: string[] = [];
    if (model.allowedRoles) {
      try {
        const parsed = typeof model.allowedRoles === 'string' 
          ? JSON.parse(model.allowedRoles) 
          : model.allowedRoles;
        if (Array.isArray(parsed)) {
          allowedRoles = parsed;
        }
      } catch {
        // If not valid JSON, treat as empty
        allowedRoles = [];
      }
    }
    
    setModelData({
      name: model.name,
      provider: model.provider || '',
      modelId: model.modelId,
      description: model.description || '',
      capabilities: model.capabilities || '',
      capabilitiesList,
      allowedRoles,
      maxTokens: model.maxTokens || 4096,
      active: model.active,
      chatEnabled: model.chatEnabled || false,
      // Pricing fields
      inputCostPer1kTokens: model.inputCostPer1kTokens || null,
      outputCostPer1kTokens: model.outputCostPer1kTokens || null,
      cachedInputCostPer1kTokens: model.cachedInputCostPer1kTokens || null,
      // Performance fields
      averageLatencyMs: model.averageLatencyMs || null,
      maxConcurrency: model.maxConcurrency || null,
      supportsBatching: model.supportsBatching || false,
      // Capability/Metadata fields - parse JSON strings if needed
      nexusCapabilities: (() => {
        if (!model.nexusCapabilities) {
          return { ...DEFAULT_NEXUS_CAPABILITIES };
        }
        try {
          return typeof model.nexusCapabilities === 'string' 
            ? JSON.parse(model.nexusCapabilities) 
            : model.nexusCapabilities;
        } catch {
          return { ...DEFAULT_NEXUS_CAPABILITIES };
        }
      })(),
      providerMetadata: (() => {
        if (!model.providerMetadata) return {};
        try {
          return typeof model.providerMetadata === 'string' 
            ? JSON.parse(model.providerMetadata) 
            : model.providerMetadata;
        } catch {
          return {};
        }
      })()
    });
  }, []);

  // Event handler for delete button
  const handleDeleteClick = useCallback((id: number) => {
    onDeleteModel?.(id);
  }, [onDeleteModel]);

  const columns = useMemo<ColumnDef<SelectAiModel>[]>(
    () => [
      {
        accessorKey: 'name',
        header: ({ column }) => <SortableColumnHeader column={column} title="Name" />,
      },
      {
        accessorKey: 'provider',
        header: ({ column }) => <SortableColumnHeader column={column} title="Provider" />,
      },
      {
        accessorKey: 'modelId',
        header: ({ column }) => <SortableColumnHeader column={column} title="Model ID" />,
      },
      {
        accessorKey: 'description',
        header: ({ column }) => <SortableColumnHeader column={column} title="Description" />,
        cell: ({ row }) => {
          const description = row.getValue('description') as string;
          return description ? (
            <div className="max-w-xs truncate" title={description}>
              {description}
            </div>
          ) : null;
        },
      },
      {
        accessorKey: 'capabilities',
        header: 'Capabilities',
        cell: ({ row }) => {
          const capabilities = row.original.capabilities;
          if (!capabilities) return null;
          
          try {
            const capList = typeof capabilities === 'string' ? JSON.parse(capabilities) : capabilities;
            if (Array.isArray(capList) && capList.length > 0) {
              return (
                <div className="flex flex-wrap gap-1 max-w-xs">
                  {capList.slice(0, 3).map((cap, idx) => (
                    <Badge key={idx} variant="secondary" className="text-xs">
                      {cap}
                    </Badge>
                  ))}
                  {capList.length > 3 && (
                    <Badge variant="outline" className="text-xs">
                      +{capList.length - 3}
                    </Badge>
                  )}
                </div>
              );
            }
          } catch {
            // If not valid JSON, just show as text
            return <span className="text-xs text-muted-foreground">{capabilities}</span>;
          }
          return null;
        },
      },
      {
        accessorKey: 'allowedRoles',
        header: 'Roles',
        cell: ({ row }) => {
          const roles = row.original.allowedRoles;
          if (!roles) return <span className="text-xs text-muted-foreground">All roles</span>;
          
          try {
            const roleList = typeof roles === 'string' ? JSON.parse(roles) : roles;
            if (Array.isArray(roleList) && roleList.length > 0) {
              return (
                <div className="flex flex-wrap gap-1 max-w-xs">
                  {roleList.map((role, idx) => (
                    <Badge key={idx} variant="outline" className="text-xs">
                      {role}
                    </Badge>
                  ))}
                </div>
              );
            }
          } catch {
            // If not valid JSON, just show as text
            return <span className="text-xs text-muted-foreground">{roles}</span>;
          }
          return <span className="text-xs text-muted-foreground">All roles</span>;
        },
      },
      {
        accessorKey: 'maxTokens',
        header: ({ column }) => (
          <SortableColumnHeader column={column} title="Max Tokens" className="text-right w-full" />
        ),
        cell: ({ row }) => {
          const value = row.getValue('maxTokens') as number;
          return <div className="text-right font-mono">{value?.toLocaleString()}</div>;
        },
      },
      {
        accessorKey: 'active',
        header: 'Active',
        cell: ({ row }) => (
          <div className="text-center">
            <Switch
              checked={row.getValue('active') as boolean}
              onCheckedChange={(checked) => handleActiveToggle(row.original.id, checked)}
            />
          </div>
        ),
      },
      {
        id: 'actions',
        header: 'Actions',
        cell: ({ row }) => (
          <div className="flex justify-center space-x-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => handleEditClick(row.original)}
              className="text-blue-500 hover:text-blue-600"
            >
              <IconEdit size={16} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => handleDeleteClick(row.original.id)}
              className="text-destructive hover:text-destructive/90"
            >
              <IconTrash size={16} />
            </Button>
          </div>
        ),
      },
    ],
    [SortableColumnHeader, handleActiveToggle, handleEditClick, handleDeleteClick]
  );

  const table = useReactTable({
    data: models || [],
    columns,
    state: {
      sorting,
    },
    enableMultiSort: true,
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const handleSubmit = useCallback(() => {
    // Convert arrays to JSON strings for database storage
    const dataToSubmit = {
      ...modelData,
      capabilities: modelData.capabilitiesList.length > 0 
        ? JSON.stringify(modelData.capabilitiesList) 
        : null,
      allowedRoles: modelData.allowedRoles.length > 0 
        ? JSON.stringify(modelData.allowedRoles) 
        : null,
      // Include all the new fields
      nexusCapabilities: Object.keys(modelData.nexusCapabilities).length > 0 
        ? modelData.nexusCapabilities 
        : null,
      providerMetadata: Object.keys(modelData.providerMetadata).length > 0 
        ? modelData.providerMetadata 
        : null
    };
    
    // Remove the list fields as they're not part of the database schema
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { capabilitiesList, ...dbData } = dataToSubmit;
    const finalData = {
      ...dbData,
      // Use explicit chatEnabled value (maintains backward compatibility by defaulting to capability-based inference)
      chatEnabled: modelData.chatEnabled,
      // Ensure pricing fields are properly set
      inputCostPer1kTokens: modelData.inputCostPer1kTokens,
      outputCostPer1kTokens: modelData.outputCostPer1kTokens,
      cachedInputCostPer1kTokens: modelData.cachedInputCostPer1kTokens,
      pricingUpdatedAt: (() => {
        // Check if any pricing field has actually changed from the existing model
        if (editingModel) {
          const pricingChanged = 
            editingModel.inputCostPer1kTokens !== modelData.inputCostPer1kTokens ||
            editingModel.outputCostPer1kTokens !== modelData.outputCostPer1kTokens ||
            editingModel.cachedInputCostPer1kTokens !== modelData.cachedInputCostPer1kTokens;
          return pricingChanged ? new Date() : editingModel.pricingUpdatedAt;
        } else {
          // For new models, set timestamp if any pricing field has a value (including 0)
          const hasPricing = 
            modelData.inputCostPer1kTokens !== null ||
            modelData.outputCostPer1kTokens !== null ||
            modelData.cachedInputCostPer1kTokens !== null;
          return hasPricing ? new Date() : null;
        }
      })(),
      // Performance fields
      averageLatencyMs: modelData.averageLatencyMs,
      maxConcurrency: modelData.maxConcurrency,
      supportsBatching: modelData.supportsBatching
    };
    
    if (editingModel) {
      onUpdateModel?.(editingModel.id, finalData);
      setEditingModel(null);
    } else {
      onAddModel?.(finalData);
      setShowAddForm(false);
    }
    setModelData(emptyModel);
  }, [editingModel, modelData, onUpdateModel, onAddModel]);

  const handleCancel = useCallback(() => {
    setShowAddForm(false);
    setEditingModel(null);
    setModelData(emptyModel);
  }, []);

  return (
    <div className="space-y-8">
      <div className="flex justify-between items-center">
        <div className="flex items-center space-x-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSorting([])}
            className="text-xs"
            disabled={sorting.length === 0}
          >
            Reset Sort
          </Button>
          {sorting.length > 0 && (
            <span className="text-sm text-muted-foreground">
              Hold Shift to sort by multiple columns
            </span>
          )}
        </div>
        <Button
          onClick={() => setShowAddForm(true)}
          className="flex items-center space-x-2"
        >
          <IconPlus size={16} />
          <span>Add Model</span>
        </Button>
      </div>

      <Dialog open={showAddForm || editingModel !== null} onOpenChange={(open) => !open && handleCancel()}>
        <DialogContent className="sm:max-w-[800px]">
          <DialogHeader>
            <DialogTitle>{editingModel ? 'Edit Model' : 'Add New Model'}</DialogTitle>
          </DialogHeader>
          <ModelForm
            modelData={modelData}
            setModelData={setModelData}
            onSubmit={handleSubmit}
            onCancel={handleCancel}
            isEditing={!!editingModel}
            roleOptions={roleOptions}
            roleLoading={roleLoading}
          />
        </DialogContent>
      </Dialog>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="bg-muted hover:bg-muted">
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id} className="h-10">
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext()
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row, index) => (
                <TableRow 
                  key={row.id}
                  className={index % 2 === 0 ? 'bg-white' : 'bg-gray-50'}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  No models found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}); 