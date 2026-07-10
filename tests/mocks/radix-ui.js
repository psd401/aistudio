// Mock Radix UI components for testing
const React = require('react');

// Mock Select components
const Select = ({ children, ...props }) => React.createElement('div', { ...props, 'data-testid': 'select' }, children);
const SelectTrigger = ({ children, ...props }) => React.createElement('button', { ...props, 'data-testid': 'select-trigger' }, children);
const SelectContent = ({ children, ...props }) => React.createElement('div', { ...props, 'data-testid': 'select-content' }, children);
const SelectItem = ({ children, ...props }) => React.createElement('div', { ...props, 'data-testid': 'select-item' }, children);
const SelectValue = ({ children, placeholder, ...props }) => React.createElement('span', { ...props, 'data-testid': 'select-value' }, children || placeholder);

// Mock Dialog components
const Dialog = ({ children, ...props }) => React.createElement('div', { ...props, 'data-testid': 'dialog' }, children);
const DialogTrigger = ({ children, ...props }) => React.createElement('button', { ...props, 'data-testid': 'dialog-trigger' }, children);
const DialogContent = ({ children, ...props }) => React.createElement('div', { ...props, 'data-testid': 'dialog-content' }, children);
const DialogHeader = ({ children, ...props }) => React.createElement('div', { ...props, 'data-testid': 'dialog-header' }, children);
const DialogTitle = ({ children, ...props }) => React.createElement('h2', { ...props, 'data-testid': 'dialog-title' }, children);
const DialogDescription = ({ children, ...props }) => React.createElement('p', { ...props, 'data-testid': 'dialog-description' }, children);
const DialogFooter = ({ children, ...props }) => React.createElement('div', { ...props, 'data-testid': 'dialog-footer' }, children);

// Mock Label
const Label = ({ children, ...props }) => React.createElement('label', { ...props, 'data-testid': 'label' }, children);

// Mock Button
const Button = React.forwardRef(({ children, ...props }, ref) => 
  React.createElement('button', { ...props, ref, 'data-testid': 'button' }, children)
);
Button.displayName = 'Button';

// Mock Input
const Input = React.forwardRef((props, ref) => 
  React.createElement('input', { ...props, ref, 'data-testid': 'input' })
);
Input.displayName = 'Input';

// Mock Card components
const Card = ({ children, ...props }) => React.createElement('div', { ...props, 'data-testid': 'card' }, children);
const CardHeader = ({ children, ...props }) => React.createElement('div', { ...props, 'data-testid': 'card-header' }, children);
const CardTitle = ({ children, ...props }) => React.createElement('h3', { ...props, 'data-testid': 'card-title' }, children);
const CardDescription = ({ children, ...props }) => React.createElement('p', { ...props, 'data-testid': 'card-description' }, children);
const CardContent = ({ children, ...props }) => React.createElement('div', { ...props, 'data-testid': 'card-content' }, children);
const CardFooter = ({ children, ...props }) => React.createElement('div', { ...props, 'data-testid': 'card-footer' }, children);

// Mock Tabs components
const Tabs = ({ children, ...props }) => React.createElement('div', { ...props, 'data-testid': 'tabs' }, children);
const TabsList = ({ children, ...props }) => React.createElement('div', { ...props, 'data-testid': 'tabs-list' }, children);
const TabsTrigger = ({ children, ...props }) => React.createElement('button', { ...props, 'data-testid': 'tabs-trigger' }, children);
const TabsContent = ({ children, ...props }) => React.createElement('div', { ...props, 'data-testid': 'tabs-content' }, children);

// Mock Badge component
const Badge = ({ children, ...props }) => React.createElement('span', { ...props, 'data-testid': 'badge' }, children);

// Mock Dropdown Menu components
const DropdownMenu = ({ children, ...props }) => React.createElement('div', { ...props, 'data-testid': 'dropdown-menu' }, children);
DropdownMenu.displayName = 'DropdownMenu';

const DropdownMenuTrigger = ({ children, ...props }) => React.createElement('button', { ...props, 'data-testid': 'dropdown-menu-trigger' }, children);
DropdownMenuTrigger.displayName = 'DropdownMenuTrigger';

const DropdownMenuContent = ({ children, ...props }) => React.createElement('div', { ...props, 'data-testid': 'dropdown-menu-content' }, children);
DropdownMenuContent.displayName = 'DropdownMenuContent';

const DropdownMenuItem = ({ children, ...props }) => React.createElement('div', { ...props, 'data-testid': 'dropdown-menu-item' }, children);
DropdownMenuItem.displayName = 'DropdownMenuItem';

const DropdownMenuSeparator = (props) => React.createElement('hr', { ...props, 'data-testid': 'dropdown-menu-separator' });
DropdownMenuSeparator.displayName = 'DropdownMenuSeparator';

const DropdownMenuLabel = ({ children, ...props }) => React.createElement('div', { ...props, 'data-testid': 'dropdown-menu-label' }, children);
DropdownMenuLabel.displayName = 'DropdownMenuLabel';

// Mock Scroll Area components  
const ScrollArea = ({ children, ...props }) => React.createElement('div', { ...props, 'data-testid': 'scroll-area' }, children);
ScrollArea.displayName = 'ScrollArea';

const ScrollBar = ({ children, ...props }) => React.createElement('div', { ...props, 'data-testid': 'scroll-bar' }, children);
ScrollBar.displayName = 'ScrollBar';

// Mock Table components
const Table = ({ children, ...props }) => React.createElement('table', { ...props, 'data-testid': 'table' }, children);
const TableHeader = ({ children, ...props }) => React.createElement('thead', { ...props, 'data-testid': 'table-header' }, children);
const TableBody = ({ children, ...props }) => React.createElement('tbody', { ...props, 'data-testid': 'table-body' }, children);
const TableRow = ({ children, ...props }) => React.createElement('tr', { ...props, 'data-testid': 'table-row' }, children);
const TableHead = ({ children, ...props }) => React.createElement('th', { ...props, 'data-testid': 'table-head' }, children);
const TableCell = ({ children, ...props }) => React.createElement('td', { ...props, 'data-testid': 'table-cell' }, children);

module.exports = {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Label,
  Button,
  Input,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Badge,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  ScrollArea,
  ScrollBar,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell
};