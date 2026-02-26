'use client';

import { useState, useCallback, memo } from 'react';
import { AiModelsTable } from './ai-models-table';
import { ModelReplacementDialog } from './model-replacement-dialog';
import type { SelectAiModel } from '@/types';
import { useToast } from '@/components/ui/use-toast';

interface AiModelsClientProps {
  initialModels: SelectAiModel[];
}

export const AiModelsClient = memo(function AiModelsClient({ initialModels = [] }: AiModelsClientProps) {
  const [models, setModels] = useState(initialModels);
  const [replacementDialog, setReplacementDialog] = useState<{
    isOpen: boolean;
    model: SelectAiModel | null;
    referenceCounts: {
      chainPrompts: number;
      conversations: number;
      modelComparisons: number;
      promptLibrary: number;
    };
  }>({
    isOpen: false,
    model: null,
    referenceCounts: { chainPrompts: 0, conversations: 0, modelComparisons: 0, promptLibrary: 0 }
  });
  const { toast } = useToast();

  const handleAddModel = useCallback(async (model: Omit<SelectAiModel, 'id' | 'createdAt' | 'updatedAt'>) => {
    try {
      const response = await fetch('/api/admin/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(model),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || 'Failed to add model');
      }

      const newModel = await response.json();
      setModels([...models, newModel.data]);
      toast({
        title: 'Success',
        description: 'AI model added successfully',
        variant: 'default',
      });
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to add AI model',
        variant: 'destructive',
      });
    }
  }, [models, toast]);

  const handleUpdateModel = useCallback(async (modelId: number, updates: Partial<SelectAiModel>) => {
    try {
      const response = await fetch('/api/admin/models', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: modelId, ...updates }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || 'Failed to update model');
      }

      const updatedModel = await response.json();
      setModels(models.map(model => 
        model.id === modelId ? updatedModel.data : model
      ));
      toast({
        title: 'Success',
        description: 'AI model updated successfully',
        variant: 'default',
      });
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to update AI model',
        variant: 'destructive',
      });
    }
  }, [models, toast]);

  const handleDeleteModel = useCallback(async (modelId: number) => {
    try {
      // First, check if the model has references
      const referenceResponse = await fetch(`/api/admin/models/${modelId}/references`);
      
      if (!referenceResponse.ok) {
        throw new Error('Failed to check model references');
      }
      
      const referenceData = await referenceResponse.json();
      
      if (referenceData.data?.hasReferences) {
        // Model has references, show replacement dialog
        const modelToDelete = models.find(m => m.id === modelId);
        if (modelToDelete) {
          const apiCounts = referenceData.data.counts;
          setReplacementDialog({
            isOpen: true,
            model: modelToDelete,
            referenceCounts: {
              chainPrompts: apiCounts.chainPrompts ?? 0,
              conversations: (apiCounts.nexusMessages ?? 0) + (apiCounts.nexusConversations ?? 0),
              modelComparisons: apiCounts.modelComparisons ?? 0,
              promptLibrary: apiCounts.promptLibrary ?? 0,
            }
          });
        }
      } else {
        // No references, proceed with direct deletion
        const response = await fetch(`/api/admin/models?id=${modelId}`, {
          method: 'DELETE',
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(errorText || 'Failed to delete model');
        }

        setModels(models.filter(model => model.id !== modelId));
        toast({
          title: 'Success',
          description: 'AI model deleted successfully',
          variant: 'default',
        });
      }
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to delete AI model',
        variant: 'destructive',
      });
    }
  }, [models, toast]);
  
  const handleModelReplacement = useCallback(async (replacementModelId: number) => {
    if (!replacementDialog.model) return;
    
    try {
      const response = await fetch(`/api/admin/models/${replacementDialog.model.id}/replace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ replacementModelId }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to replace model');
      }

      const result = await response.json();
      
      // Remove the deleted model from the list
      setModels(models.filter(model => model.id !== replacementDialog.model?.id));
      
      // Close the dialog
      setReplacementDialog({
        isOpen: false,
        model: null,
        referenceCounts: { chainPrompts: 0, conversations: 0, modelComparisons: 0, promptLibrary: 0 }
      });
      
      toast({
        title: 'Success',
        description: result.message || 'Model replaced and deleted successfully',
        variant: 'default',
      });
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to replace model',
        variant: 'destructive',
      });
    }
  }, [replacementDialog.model, models, toast]);

  return (
    <>
      <AiModelsTable
        models={models}
        onAddModel={handleAddModel}
        onDeleteModel={handleDeleteModel}
        onUpdateModel={handleUpdateModel}
      />
      
      {replacementDialog.model && (
        <ModelReplacementDialog
          isOpen={replacementDialog.isOpen}
          onClose={() => setReplacementDialog({
            isOpen: false,
            model: null,
            referenceCounts: { chainPrompts: 0, conversations: 0, modelComparisons: 0, promptLibrary: 0 }
          })}
          modelToDelete={replacementDialog.model}
          availableModels={models}
          referenceCounts={replacementDialog.referenceCounts}
          onConfirm={handleModelReplacement}
        />
      )}
    </>
  );
}); 