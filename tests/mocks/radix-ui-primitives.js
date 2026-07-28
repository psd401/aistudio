// Mock all Radix UI primitive components for testing
const React = require('react');

// Generic primitive component factory
const createPrimitive = (displayName) => {
  const Component = React.forwardRef(({ children, ...props }, ref) =>
    React.createElement('div', { ...props, ref, 'data-testid': displayName.toLowerCase() }, children)
  );
  Component.displayName = displayName;
  return Component;
};

// Mock all common primitive exports
const mockExports = {
  // Dropdown Menu primitives
  Root: createPrimitive('DropdownMenuRoot'),
  Trigger: createPrimitive('DropdownMenuTrigger'),
  Content: createPrimitive('DropdownMenuContent'),
  Item: createPrimitive('DropdownMenuItem'),
  Separator: createPrimitive('DropdownMenuSeparator'),
  Label: createPrimitive('DropdownMenuLabel'),
  Portal: createPrimitive('DropdownMenuPortal'),
  SubTrigger: createPrimitive('DropdownMenuSubTrigger'),
  SubContent: createPrimitive('DropdownMenuSubContent'),
  Sub: createPrimitive('DropdownMenuSub'),
  Group: createPrimitive('DropdownMenuGroup'),
  CheckboxItem: createPrimitive('DropdownMenuCheckboxItem'),
  RadioGroup: createPrimitive('DropdownMenuRadioGroup'),
  RadioItem: createPrimitive('DropdownMenuRadioItem'),
  ItemIndicator: createPrimitive('DropdownMenuItemIndicator'),
  Arrow: createPrimitive('DropdownMenuArrow'),

  // Scroll Area primitives
  Viewport: createPrimitive('ScrollAreaViewport'),
  Scrollbar: createPrimitive('ScrollAreaScrollbar'),
  ScrollAreaScrollbar: createPrimitive('ScrollAreaScrollbar'), // Alternative name
  ScrollAreaThumb: createPrimitive('ScrollAreaThumb'),
  Thumb: createPrimitive('ScrollAreaThumb'),
  Corner: createPrimitive('ScrollAreaCorner'),

  // Dialog primitives
  Close: createPrimitive('DialogClose'),
  Overlay: createPrimitive('DialogOverlay'),
  Title: createPrimitive('DialogTitle'),
  Description: createPrimitive('DialogDescription'),

  // Select primitives
  Value: createPrimitive('SelectValue'),
  Icon: createPrimitive('SelectIcon'),

  // Generic properties that might be accessed
  displayName: 'MockedPrimitive',
  __docgenInfo: {}
};

// Export all as default and named exports to cover different import patterns
module.exports = mockExports;
module.exports.default = mockExports;

// Also export individual named exports
for (const key of Object.keys(mockExports)) {
  module.exports[key] = mockExports[key];
};