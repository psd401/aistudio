// Mock for @/components/ui/dropdown-menu
const React = require('react');

const DropdownMenu = ({ children, ...props }) =>
  React.createElement('div', { ...props, 'data-testid': 'dropdown-menu' }, children);
DropdownMenu.displayName = 'DropdownMenu';

const DropdownMenuTrigger = ({ children, ...props }) =>
  React.createElement('button', { ...props, 'data-testid': 'dropdown-menu-trigger' }, children);
DropdownMenuTrigger.displayName = 'DropdownMenuTrigger';

const DropdownMenuContent = ({ children, sideOffset: _sideOffset, ...props }) =>
  React.createElement('div', { ...props, 'data-testid': 'dropdown-menu-content' }, children);
DropdownMenuContent.displayName = 'DropdownMenuContent';

const DropdownMenuItem = ({ children, inset: _inset, ...props }) =>
  React.createElement('div', { ...props, 'data-testid': 'dropdown-menu-item' }, children);
DropdownMenuItem.displayName = 'DropdownMenuItem';

const DropdownMenuCheckboxItem = React.forwardRef(({ children, checked, ...props }, ref) =>
  React.createElement('div', {
    ...props,
    ref,
    'data-testid': 'dropdown-menu-checkbox-item',
    'data-checked': checked
  }, children)
);
DropdownMenuCheckboxItem.displayName = 'DropdownMenuCheckboxItem';

const DropdownMenuRadioItem = React.forwardRef(({ children, ...props }, ref) =>
  React.createElement('div', { ...props, ref, 'data-testid': 'dropdown-menu-radio-item' }, children)
);
DropdownMenuRadioItem.displayName = 'DropdownMenuRadioItem';

const DropdownMenuLabel = ({ children, inset: _inset, ...props }) =>
  React.createElement('div', { ...props, 'data-testid': 'dropdown-menu-label' }, children);
DropdownMenuLabel.displayName = 'DropdownMenuLabel';

const DropdownMenuSeparator = (props) =>
  React.createElement('hr', { ...props, 'data-testid': 'dropdown-menu-separator' });
DropdownMenuSeparator.displayName = 'DropdownMenuSeparator';

const DropdownMenuShortcut = ({ className: _className, ...props }) =>
  React.createElement('span', { ...props, 'data-testid': 'dropdown-menu-shortcut' });
DropdownMenuShortcut.displayName = 'DropdownMenuShortcut';

const DropdownMenuGroup = ({ children, ...props }) =>
  React.createElement('div', { ...props, 'data-testid': 'dropdown-menu-group' }, children);
DropdownMenuGroup.displayName = 'DropdownMenuGroup';

const DropdownMenuPortal = ({ children, ...props }) =>
  React.createElement('div', { ...props, 'data-testid': 'dropdown-menu-portal' }, children);
DropdownMenuPortal.displayName = 'DropdownMenuPortal';

const DropdownMenuSub = ({ children, ...props }) =>
  React.createElement('div', { ...props, 'data-testid': 'dropdown-menu-sub' }, children);
DropdownMenuSub.displayName = 'DropdownMenuSub';

const DropdownMenuSubContent = React.forwardRef(({ children, ...props }, ref) =>
  React.createElement('div', { ...props, ref, 'data-testid': 'dropdown-menu-sub-content' }, children)
);
DropdownMenuSubContent.displayName = 'DropdownMenuSubContent';

const DropdownMenuSubTrigger = React.forwardRef(({ children, inset: _inset, ...props }, ref) =>
  React.createElement('div', { ...props, ref, 'data-testid': 'dropdown-menu-sub-trigger' }, children)
);
DropdownMenuSubTrigger.displayName = 'DropdownMenuSubTrigger';

const DropdownMenuRadioGroup = ({ children, ...props }) =>
  React.createElement('div', { ...props, 'data-testid': 'dropdown-menu-radio-group' }, children);
DropdownMenuRadioGroup.displayName = 'DropdownMenuRadioGroup';

module.exports = {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuRadioGroup
};
