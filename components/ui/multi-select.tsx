'use client';

import React, { useState, useEffect, startTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Badge } from '@/components/ui/badge';
import { ChevronDown, Plus, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';

export interface MultiSelectOption {
  value: string;
  label: string;
  description?: string;
}

interface MultiSelectProps {
  options: MultiSelectOption[];
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  allowCustom?: boolean;
  customPlaceholder?: string;
  required?: boolean;
  className?: string;
}

export function MultiSelect({
  options,
  value = [],
  onChange,
  placeholder = "Select items",
  disabled = false,
  allowCustom = false,
  customPlaceholder = "Add custom item...",
  required = false,
  className = "w-[200px]"
}: MultiSelectProps) {
  const [selectedItems, setSelectedItems] = useState<string[]>(value);
  const [isOpen, setIsOpen] = useState(false);
  const [customInput, setCustomInput] = useState('');
  const [customItems, setCustomItems] = useState<string[]>([]);

  useEffect(() => {
    startTransition(() => { setSelectedItems(value) });
    // Extract custom items (items not in predefined options)
    if (allowCustom) {
      const optionValues = options.map(o => o.value);
      const custom = value.filter(v => !optionValues.includes(v));
      startTransition(() => { setCustomItems(custom) });
    }
  }, [value, options, allowCustom]);

  const handleItemToggle = (item: string) => {
    const newItems = selectedItems.includes(item)
      ? selectedItems.filter(i => i !== item)
      : [...selectedItems, item];
    setSelectedItems(newItems);
  };

  const handleAddCustom = () => {
    if (customInput.trim() && !selectedItems.includes(customInput.trim())) {
      const newItem = customInput.trim();
      setSelectedItems([...selectedItems, newItem]);
      setCustomItems([...customItems, newItem]);
      setCustomInput('');
    }
  };

  const handleRemoveCustom = (item: string) => {
    setSelectedItems(selectedItems.filter(i => i !== item));
    setCustomItems(customItems.filter(i => i !== item));
  };

  const handleSave = () => {
    onChange(selectedItems);
    setIsOpen(false);
  };

  const handleCancel = () => {
    setSelectedItems(value);
    setCustomItems(customItems);
    setIsOpen(false);
  };

  const isValid = !required || selectedItems.length > 0;

  // Combine predefined options with custom items for display
  const allOptions = [
    ...options,
    ...customItems.map(item => ({
      value: item,
      label: item,
      description: 'Custom'
    }))
  ];

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen} modal={true}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          disabled={disabled}
          className={`justify-between ${className}`}
        >
          <div className="flex gap-1 overflow-hidden flex-1">
            {selectedItems.length === 0 ? (
              <span className="text-muted-foreground">{placeholder}</span>
            ) : selectedItems.length === 1 ? (
              <span className="truncate">{selectedItems[0]}</span>
            ) : (
              <div className="flex gap-1 flex-1">
                <Badge variant="secondary" className="text-xs">
                  {selectedItems[0]}
                </Badge>
                {selectedItems.length > 1 && (
                  <Badge variant="secondary" className="text-xs">
                    +{selectedItems.length - 1}
                  </Badge>
                )}
              </div>
            )}
          </div>
          <ChevronDown className="h-4 w-4 opacity-50 flex-shrink-0 ml-2" />
        </Button>
      </PopoverTrigger>
      <PopoverContent 
        className="w-[320px] p-4 max-h-[400px] overflow-hidden flex flex-col z-[60]" 
        align="start" 
        alignOffset={-5}
        side="bottom"
        sideOffset={5}
        collisionPadding={10}
        avoidCollisions={true}
        forceMount>
        <div className="space-y-4 flex-1 overflow-hidden flex flex-col">
          <div className="flex-1 overflow-hidden flex flex-col">
            <div className="flex items-center justify-between mb-3 flex-shrink-0">
              <h4 className="font-medium text-sm">Select Items</h4>
              {selectedItems.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSelectedItems([]);
                    setCustomItems([]);
                  }}
                  className="h-7 px-2 text-xs text-destructive hover:text-destructive-foreground hover:bg-destructive"
                >
                  Clear All ({selectedItems.length})
                </Button>
              )}
            </div>
            
            {allowCustom && (
              <div className="flex gap-2 mb-3 flex-shrink-0">
                <Input
                  placeholder={customPlaceholder}
                  value={customInput}
                  onChange={(e) => setCustomInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddCustom();
                    }
                  }}
                  className="flex-1"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleAddCustom}
                  disabled={!customInput.trim()}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            )}
            
            <ScrollArea className="flex-1 overflow-auto" style={{ maxHeight: 250 }}>
              <div className="space-y-2">
                {allOptions.map((option) => {
                  const isCustom = customItems.includes(option.value);
                  return (
                    <div
                      key={option.value}
                      className="flex items-start space-x-2 py-2"
                    >
                      <Checkbox
                        id={`item-${option.value}`}
                        checked={selectedItems.includes(option.value)}
                        onCheckedChange={() => handleItemToggle(option.value)}
                        className="mt-0.5"
                      />
                      <label
                        htmlFor={`item-${option.value}`}
                        className="flex-1 cursor-pointer"
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">{option.label}</span>
                          {isCustom && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-4 w-4 p-0"
                              onClick={(e) => {
                                e.preventDefault();
                                handleRemoveCustom(option.value);
                              }}
                            >
                              <X className="h-3 w-3" />
                            </Button>
                          )}
                        </div>
                        {option.description && (
                          <div className="text-xs text-muted-foreground">
                            {option.description}
                          </div>
                        )}
                      </label>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          </div>
          
          {required && !isValid && (
            <div className="text-xs text-destructive flex-shrink-0">
              At least one item must be selected
            </div>
          )}
          
          <div className="flex justify-end space-x-2 pt-2 border-t flex-shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCancel}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!isValid}
            >
              Apply
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}