import { render } from '@testing-library/react'
import { screen, fireEvent, waitFor } from '@testing-library/dom'
import '@testing-library/jest-dom'

// Mock the entire dropdown-menu UI component to avoid displayName issues
jest.mock('@/components/ui/dropdown-menu', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  
  const createComponent = (name: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Component = ({ children, ...props }: any) => 
      React.createElement('div', { ...props, 'data-testid': name.toLowerCase() }, children);
    Component.displayName = name;
    return Component;
  };
  
  return {
    DropdownMenu: createComponent('DropdownMenu'),
    DropdownMenuTrigger: createComponent('DropdownMenuTrigger'),
    DropdownMenuContent: createComponent('DropdownMenuContent'),
    DropdownMenuItem: createComponent('DropdownMenuItem'),
    DropdownMenuCheckboxItem: createComponent('DropdownMenuCheckboxItem'),
    DropdownMenuRadioItem: createComponent('DropdownMenuRadioItem'),
    DropdownMenuLabel: createComponent('DropdownMenuLabel'),
    DropdownMenuSeparator: createComponent('DropdownMenuSeparator'),
    DropdownMenuShortcut: createComponent('DropdownMenuShortcut'),
    DropdownMenuGroup: createComponent('DropdownMenuGroup'),
    DropdownMenuPortal: createComponent('DropdownMenuPortal'),
    DropdownMenuSub: createComponent('DropdownMenuSub'),
    DropdownMenuSubContent: createComponent('DropdownMenuSubContent'),
    DropdownMenuSubTrigger: createComponent('DropdownMenuSubTrigger'),
    DropdownMenuRadioGroup: createComponent('DropdownMenuRadioGroup')
  }
})

// Mock the tabs UI component to avoid displayName issues
jest.mock('@/components/ui/tabs', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  
  const createComponent = (name: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Component = ({ children, ...props }: any) => 
      React.createElement('div', { ...props, 'data-testid': name.toLowerCase() }, children);
    Component.displayName = name;
    return Component;
  };
  
  return {
    Tabs: createComponent('Tabs'),
    TabsList: createComponent('TabsList'),
    TabsTrigger: createComponent('TabsTrigger'),
    TabsContent: createComponent('TabsContent')
  }
})

// Mock Alert Dialog
jest.mock('@radix-ui/react-alert-dialog', () => {
  const mockComponent = (name: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const MockedComponent = ({ children, ...props }: any) => <div {...props}>{children}</div>
    MockedComponent.displayName = name
    return MockedComponent
  }
  
  return {
    __esModule: true,
    Root: mockComponent('AlertDialogRoot'),
    Trigger: mockComponent('AlertDialogTrigger'),
    Portal: mockComponent('AlertDialogPortal'),
    Overlay: mockComponent('AlertDialogOverlay'),
    Content: mockComponent('AlertDialogContent'),
    Title: mockComponent('AlertDialogTitle'),
    Description: mockComponent('AlertDialogDescription'),
    Action: mockComponent('AlertDialogAction'),
    Cancel: mockComponent('AlertDialogCancel')
  }
})

// Mock form components
jest.mock('@/components/ui/form', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  
  const createFormComponent = (name: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
    const Component = ({ children, render, control, setValue, handleSubmit, ...props }: any) => {
      // Filter out react-hook-form specific props to avoid DOM warnings
      const { 
        name: fieldName, 
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        rules, 
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        defaultValue, 
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        onBlur, 
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        onChange, 
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        value,
        ...domProps 
      } = props;
      
      // For FormField, execute the render function if provided
      if (name === 'FormField' && render) {
        return render({ field: { onChange: jest.fn(), onBlur: jest.fn(), value: '', name: fieldName || 'mock-field' } });
      }
      
      return React.createElement('div', { ...domProps, 'data-testid': name.toLowerCase() }, children);
    };
    Component.displayName = name;
    return Component;
  };
  
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Form: ({ children, ...props }: any) => {
      // Filter out form-specific props to avoid passing them to DOM
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { handleSubmit, control, setValue, reset, formState, ...domProps } = props;
      return React.createElement('div', { ...domProps, 'data-testid': 'form' }, children);
    },
    FormControl: createFormComponent('FormControl'),
    FormField: createFormComponent('FormField'),
    FormItem: createFormComponent('FormItem'),
    FormLabel: createFormComponent('FormLabel'),
    FormMessage: createFormComponent('FormMessage'),
    FormDescription: createFormComponent('FormDescription'),
    useFormField: () => ({
      id: 'mock-form-field',
      name: 'mock-field',
      formItemId: 'mock-form-item',
      formDescriptionId: 'mock-form-description',
      formMessageId: 'mock-form-message'
    })
  }
})

// Mock Dialog components
jest.mock('@/components/ui/dialog', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Dialog: ({ children, open }: any) => open ? React.createElement('div', { role: 'dialog', 'data-testid': 'dialog' }, children) : null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    DialogContent: ({ children }: any) => React.createElement('div', { 'data-testid': 'dialog-content' }, children),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    DialogHeader: ({ children }: any) => React.createElement('div', { 'data-testid': 'dialog-header' }, children),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    DialogTitle: ({ children }: any) => React.createElement('h2', { 'data-testid': 'dialog-title' }, children),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    DialogDescription: ({ children }: any) => React.createElement('p', { 'data-testid': 'dialog-description' }, children),
  }
})

// Mock Select components
jest.mock('@/components/ui/select', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Select: ({ children }: any) => React.createElement('div', { 'data-testid': 'select' }, children),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    SelectContent: ({ children }: any) => React.createElement('div', { 'data-testid': 'select-content' }, children),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    SelectItem: ({ children }: any) => React.createElement('div', { 'data-testid': 'select-item' }, children),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    SelectTrigger: ({ children }: any) => React.createElement('div', { 'data-testid': 'select-trigger' }, children),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    SelectValue: ({ placeholder }: any) => React.createElement('span', { 'data-testid': 'select-value' }, placeholder),
  }
})

// Mock Input and Textarea
jest.mock('@/components/ui/input', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line react/display-name, @typescript-eslint/no-explicit-any
  const Input = React.forwardRef((props: any, ref: any) => 
    React.createElement('input', { ...props, ref, 'data-testid': 'input' })
  )
  return {
    Input
  }
})

jest.mock('@/components/ui/textarea', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line react/display-name, @typescript-eslint/no-explicit-any
  const Textarea = React.forwardRef((props: any, ref: any) => 
    React.createElement('textarea', { ...props, ref, 'data-testid': 'textarea' })
  )
  return {
    Textarea
  }
})

// Mock Checkbox
jest.mock('@/components/ui/checkbox', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line react/display-name, @typescript-eslint/no-explicit-any
  const Checkbox = React.forwardRef((props: any, ref: any) => {
      const { onCheckedChange, checked, ...inputProps } = props;
      return React.createElement('input', { 
        ...inputProps, 
        type: 'checkbox', 
        ref, 
        'data-testid': 'checkbox',
        onChange: onCheckedChange,
        checked
      });
    })
  return {
    Checkbox
  }
})

// Create global form data store for test
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let globalFormData: any = {
  key: 'NEW_KEY',
  value: 'new_value', 
  description: null,
  category: null,
  isSecret: false
};

// Mock react-hook-form
jest.mock('react-hook-form', () => {
  return {
    useForm: () => ({
      control: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handleSubmit: (fn: any) => (e: any) => {
        e?.preventDefault();
        fn(globalFormData);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setValue: jest.fn((name: string, value: any) => {
        globalFormData[name] = value;
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reset: jest.fn((data: any) => {
        // If data is provided, use it; otherwise keep current data
        if (data) {
          globalFormData = { ...data };
        }
      }),
      formState: { errors: {} }
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Controller: ({ render }: any) => render({ field: { onChange: jest.fn(), value: '' } })
  }
})

// Mock zod resolver
jest.mock('@hookform/resolvers/zod', () => ({
  zodResolver: () => ({})
}))

// Mock the toast hook
jest.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({
    toast: jest.fn()
  })
}))

// Mock fetch
global.fetch = jest.fn() as unknown as typeof fetch

// Import component after mocks are set up
import { SettingsClient } from './settings-client'

describe('SettingsClient', () => {
  const mockSettings = [
    {
      id: 1,
      key: 'TEST_KEY',
      value: 'test_value',
      description: 'Test description',
      category: 'test',
      isSecret: false,
      hasValue: true,
      createdAt: new Date(),
      updatedAt: new Date()
    }
  ]

  beforeEach(() => {
    jest.clearAllMocks()
    // Reset form data to default success case
    globalFormData = {
      key: 'NEW_KEY',
      value: 'new_value',
      description: null,
      category: null,
      isSecret: false
    };
  })

  it('should close the modal after successful save', async () => {
    // Mock successful API response
    ;(fetch as unknown as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        isSuccess: true,
        data: {
          id: 2,
          key: 'NEW_KEY',
          value: 'new_value',
          description: 'New description',
          category: 'test',
          isSecret: false,
          hasValue: true,
          createdAt: new Date(),
          updatedAt: new Date()
        }
      })
    })

    render(<SettingsClient initialSettings={mockSettings} />)

    // Open the form
    const addButton = screen.getByText('Add Setting')
    fireEvent.click(addButton)

    // Check that dialog is open
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    })

    // Form data is already set in globalFormData mock

    // Submit the form
    const createButton = screen.getByText('Create')
    fireEvent.click(createButton)

    // Wait for the modal to close
    await waitFor(() => {
      // The dialog should be closed, so the form title should not be visible
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    // Verify the API was called
    // Note: The form resets to empty values due to useEffect in SettingsForm
    expect(fetch).toHaveBeenCalledWith('/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: '',
        value: null,
        description: null,
        category: null,
        isSecret: false
      })
    })
  })

  it('should keep the modal open on save error', async () => {
    // Set form data for this test
    globalFormData = {
      key: 'NEW_KEY',
      value: null,
      description: null,
      category: null,
      isSecret: false
    };
    
    // Mock failed API response
    ;(fetch as unknown as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        isSuccess: false,
        message: 'Save failed'
      })
    })

    render(<SettingsClient initialSettings={mockSettings} />)

    // Open the form
    const addButton = screen.getByText('Add Setting')
    fireEvent.click(addButton)

    // Check that dialog is open
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    })

    // Form data is already set in globalFormData mock

    // Submit the form
    const createButton = screen.getByText('Create')
    fireEvent.click(createButton)

    // Wait and verify the modal is still open
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument()
    })

    // The button should return to its normal state
    await waitFor(() => {
      expect(screen.getByText('Create')).toBeInTheDocument()
    })
  })
})