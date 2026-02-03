// Set required environment variables for Drizzle DB client initialization
// These must be set BEFORE any imports to prevent initialization errors
process.env.RDS_SECRET_ARN = 'test-secret-arn';
process.env.RDS_RESOURCE_ARN = 'test-resource-arn';
process.env.RDS_DATABASE_NAME = 'test-database';

import '@testing-library/jest-dom';

// Mock auth factory
jest.mock('@/auth', () => ({
  createAuth: jest.fn(() => ({
    auth: jest.fn().mockResolvedValue({
      user: {
        id: 'test-cognito-sub',
        email: 'test@example.com'
      }
    }),
    signIn: jest.fn(),
    signOut: jest.fn()
  })),
  authMiddleware: jest.fn(),
  createAuthHandlers: jest.fn(() => ({
    GET: jest.fn(),
    POST: jest.fn()
  }))
}));

// Mock request context
jest.mock('@/lib/auth/request-context', () => ({
  createRequestContext: () => Promise.resolve({
    requestId: 'test-request-id'
  })
}));

// Mock AWS Cognito authentication
jest.mock('@/lib/auth/server-session', () => ({
  getServerSession: jest.fn(() => Promise.resolve({ 
    sub: 'test-cognito-sub',
    email: 'test@example.com'
  }))
}));

jest.mock('aws-amplify', () => ({
  Amplify: {
    configure: jest.fn()
  }
}));

// Mock logger
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  },
  createLogger: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  })),
  generateRequestId: jest.fn(() => 'test-request-id'),
  getLogContext: jest.fn(() => ({ requestId: 'test-request-id', userId: 'test-user' })),
  sanitizeForLogging: jest.fn((data) => data),
  startTimer: jest.fn(() => jest.fn())
}));

// Mock ResizeObserver
class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

global.ResizeObserver = ResizeObserver;

// Add TextEncoder/TextDecoder for Node environment
if (typeof global.TextEncoder === 'undefined') {
  const { TextEncoder, TextDecoder } = require('util');
  global.TextEncoder = TextEncoder;
  global.TextDecoder = TextDecoder;
}

// Add ReadableStream polyfill for SSE testing
if (typeof global.ReadableStream === 'undefined') {
  try {
    const { ReadableStream } = require('stream/web');
    global.ReadableStream = ReadableStream;
  } catch (e) {
    // Fallback for older Node versions
    // Create a minimal polyfill for testing purposes
    global.ReadableStream = class ReadableStream {
      constructor({ start }) {
        this._chunks = [];
        this._done = false;
        this._controller = {
          enqueue: (chunk) => this._chunks.push(chunk),
          close: () => { this._done = true; },
          error: (error) => { this._error = error; this._done = true; }
        };
        if (start) {
          Promise.resolve().then(() => start(this._controller));
        }
      }

      getReader() {
        let index = 0;
        return {
          read: async () => {
            // Wait for chunks to be available or stream to be done
            while (index >= this._chunks.length && !this._done) {
              await new Promise(resolve => setTimeout(resolve, 10));
            }

            if (this._error) {
              throw this._error;
            }

            if (index < this._chunks.length) {
              return { done: false, value: this._chunks[index++] };
            }

            return { done: true, value: undefined };
          },
          releaseLock: () => {}
        };
      }
    };
  }
}

// Add Response polyfill for SSE testing
// Note: Don't check Response.prototype.body - it's a getter and causes "Illegal invocation" error
if (typeof global.Response === 'undefined' || !global.Response.prototype) {
  try {
    const { Response, Headers } = require('undici');
    global.Response = Response;
    global.Headers = Headers;
  } catch (e) {
    // Minimal Response polyfill
    global.Headers = class Headers extends Map {
      get(key) {
        return super.get(key.toLowerCase());
      }
      set(key, value) {
        return super.set(key.toLowerCase(), value);
      }
    };

    global.Response = class Response {
      constructor(body, init = {}) {
        this.body = body;
        this.status = init.status || 200;
        this.headers = init.headers instanceof global.Headers ? init.headers : new global.Headers(Object.entries(init.headers || {}));
      }
    };
  }
}

// Add TransformStream polyfill for eventsource-parser
if (typeof global.TransformStream === 'undefined') {
  global.TransformStream = class TransformStream {
    readable = {
      getReader: () => ({ read: () => Promise.resolve({ done: true, value: undefined }) })
    };
    writable = {
      getWriter: () => ({
        write: () => Promise.resolve(),
        close: () => Promise.resolve(),
        releaseLock: () => {}
      })
    };
  };
}

// Mock Next.js server components
jest.mock('next/server', () => ({
  NextRequest: jest.fn(),
  NextResponse: class NextResponse {
    constructor(body, init) {
      this.body = body;
      this.status = init?.status || 200;
      this.headers = new Map(Object.entries(init?.headers || {}));
      // Add get method for compatibility
      if (!this.headers.get) {
        this.headers.get = this.headers.get || function(key) {
          return this.get(key);
        };
      }
    }
    
    json() {
      return Promise.resolve(JSON.parse(this.body));
    }
    
    static json(data, init) {
      return new NextResponse(JSON.stringify(data), {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...(init?.headers || {})
        }
      });
    }

    static next() {
      return new NextResponse(null, { status: 200 });
    }

    static redirect(url, status = 307) {
      return new NextResponse(null, { 
        status, 
        headers: { 
          location: typeof url === 'string' ? url : url.toString()
        } 
      });
    }
  }
}));

// Mock Radix UI primitives
jest.mock('@radix-ui/react-slot', () => {
  const React = require('react');
  
  const Slot = React.forwardRef(({ children, ...props }, ref) => {
    if (React.Children.count(children) === 1) {
      const child = React.Children.only(children);
      if (React.isValidElement(child)) {
        return React.cloneElement(child, {
          ...props,
          ...child.props,
          ref
        });
      }
    }
    return React.createElement('div', { ...props, ref }, children);
  });
  
  const SlotClone = React.forwardRef(({ children, ...props }, ref) => {
    return React.createElement('span', { ...props, ref }, children);
  });
  
  const createSlot = (name) => ({
    __scopedNameSlot: Symbol(name),
    Provider: ({ children }) => children,
    Slot: Slot,
    SlotClone: SlotClone
  });
  
  return {
    Slot,
    SlotClone,
    createSlot
  };
});

// Mock Radix UI Primitive
jest.mock('@radix-ui/react-primitive', () => {
  const React = require('react');
  
  const Primitive = {
    div: React.forwardRef((props, ref) => React.createElement('div', { ...props, ref })),
    span: {
      SlotClone: React.forwardRef((props, ref) => React.createElement('span', { ...props, ref }))
    },
    button: React.forwardRef((props, ref) => React.createElement('button', { ...props, ref })),
    input: React.forwardRef((props, ref) => React.createElement('input', { ...props, ref })),
    label: React.forwardRef((props, ref) => React.createElement('label', { ...props, ref })),
    select: React.forwardRef((props, ref) => React.createElement('select', { ...props, ref })),
    option: React.forwardRef((props, ref) => React.createElement('option', { ...props, ref }))
  };
  
  return {
    Primitive
  };
});

// Mock Radix UI Collection
jest.mock('@radix-ui/react-collection', () => {
  const React = require('react');
  
  const createCollection = (name) => ({
    __scopedNameCollection: Symbol(name),
    Provider: ({ children }) => children,
    Slot: React.forwardRef((props, ref) => React.createElement('div', { ...props, ref })),
    ItemSlot: React.forwardRef((props, ref) => React.createElement('div', { ...props, ref }))
  });
  
  return {
    createCollection
  };
});

// Mock Radix UI Select
jest.mock('@radix-ui/react-select', () => {
  const React = require('react');
  
  const createMockComponent = (displayName) => {
    const Component = React.forwardRef((props, ref) => 
      React.createElement('div', { ...props, ref })
    );
    Component.displayName = displayName;
    return Component;
  };
  
  const Select = ({ children, ...props }) => React.createElement('div', props, children);
  Select.displayName = 'Select';
  
  const SelectTrigger = createMockComponent('SelectTrigger');
  const SelectValue = createMockComponent('SelectValue');  
  const SelectContent = createMockComponent('SelectContent');
  const SelectViewport = createMockComponent('SelectViewport');
  const SelectItem = createMockComponent('SelectItem');
  const SelectItemText = createMockComponent('SelectItemText');
  const SelectItemIndicator = createMockComponent('SelectItemIndicator');
  const SelectScrollUpButton = createMockComponent('SelectScrollUpButton');
  const SelectScrollDownButton = createMockComponent('SelectScrollDownButton');
  const SelectLabel = createMockComponent('SelectLabel');
  const SelectSeparator = createMockComponent('SelectSeparator');
  const SelectGroup = createMockComponent('SelectGroup');
  const SelectIcon = createMockComponent('SelectIcon');
  
  return {
    Root: Select,
    Trigger: SelectTrigger,
    Value: SelectValue,
    Content: SelectContent,
    Viewport: SelectViewport,
    Item: SelectItem,
    ItemText: SelectItemText,
    ItemIndicator: SelectItemIndicator,
    ScrollUpButton: SelectScrollUpButton,
    ScrollDownButton: SelectScrollDownButton,
    Label: SelectLabel,
    Separator: SelectSeparator,
    Group: SelectGroup,
    Icon: SelectIcon
  };
});

// Mock Radix UI Context
jest.mock('@radix-ui/react-context', () => ({
  createContext: (rootComponentName, defaultContext) => {
    const React = require('react');
    const Context = React.createContext(defaultContext);
    
    const Provider = ({ children, ...props }) => {
      return React.createElement(Context.Provider, { value: props }, children);
    };
    
    const useContext = (consumerName) => {
      return React.useContext(Context);
    };
    
    return [Provider, useContext];
  }
}));

// Mock UI Components directly
jest.mock('@/components/ui/select', () => {
  const React = require('react');
  
  const Select = ({ children, defaultValue, onValueChange, disabled, ...props }) => {
    // Create a context to share the selected value
    const [value, setValue] = React.useState(defaultValue);
    
    const handleValueChange = (newValue) => {
      setValue(newValue);
      onValueChange?.(newValue);
    };
    
    return React.createElement('div', { 
      ...props, 
      'data-testid': props['data-testid'] || 'select',
      'data-value': value 
    }, React.Children.map(children, child => {
      if (React.isValidElement(child)) {
        return React.cloneElement(child, { onValueChange: handleValueChange, value, disabled });
      }
      return child;
    }));
  };
  
  const SelectTrigger = React.forwardRef(({ children, onValueChange, value, disabled, ...props }, ref) => 
    React.createElement('button', { 
      ...props, 
      ref,
      type: 'button',
      value: value,
      disabled: disabled
    }, children)
  );
  
  const SelectValue = React.forwardRef(({ children, placeholder, ...props }, ref) => 
    React.createElement('span', { 
      ...props, 
      ref,
      'data-placeholder': placeholder 
    }, children || placeholder)
  );
  
  const SelectContent = React.forwardRef(({ children, onValueChange, ...props }, ref) => 
    React.createElement('div', { 
      ...props, 
      ref 
    }, React.Children.map(children, child => {
      if (React.isValidElement(child)) {
        return React.cloneElement(child, { onValueChange });
      }
      return child;
    }))
  );
  
  const SelectItem = React.forwardRef(({ children, value, onValueChange, ...props }, ref) => 
    React.createElement('div', { 
      ...props, 
      ref,
      'data-value': value,
      onClick: () => onValueChange?.(value)
    }, children)
  );
  
  const SelectGroup = React.forwardRef(({ children, ...props }, ref) => 
    React.createElement('div', { ...props, ref }, children)
  );
  
  return {
    Select,
    SelectTrigger,
    SelectValue,
    SelectContent,
    SelectItem,
    SelectGroup
  };
});

// Mock Radix UI Dropdown Menu
jest.mock('@radix-ui/react-dropdown-menu', () => {
  const React = require('react');
  
  const createMockComponent = (displayName) => {
    const Component = React.forwardRef((props, ref) => 
      React.createElement('div', { ...props, ref })
    );
    Component.displayName = displayName;
    return Component;
  };
  
  // Create consistent component references
  const SubTrigger = createMockComponent('DropdownMenuSubTrigger');
  const SubContent = createMockComponent('DropdownMenuSubContent');
  const Content = createMockComponent('DropdownMenuContent');
  const Item = createMockComponent('DropdownMenuItem');
  const CheckboxItem = createMockComponent('DropdownMenuCheckboxItem');
  const RadioItem = createMockComponent('DropdownMenuRadioItem');
  const Label = createMockComponent('DropdownMenuLabel');
  const Separator = createMockComponent('DropdownMenuSeparator');
  
  return {
    Root: createMockComponent('DropdownMenuRoot'),
    Trigger: createMockComponent('DropdownMenuTrigger'),
    Content,
    Item,
    Separator,
    Label,
    Portal: createMockComponent('DropdownMenuPortal'),
    SubTrigger,
    SubContent,
    Sub: createMockComponent('DropdownMenuSub'),
    Group: createMockComponent('DropdownMenuGroup'),
    CheckboxItem,
    RadioGroup: createMockComponent('DropdownMenuRadioGroup'),
    RadioItem,
    ItemIndicator: createMockComponent('DropdownMenuItemIndicator'),
    Arrow: createMockComponent('DropdownMenuArrow')
  };
});

// Mock Radix UI Scroll Area
jest.mock('@radix-ui/react-scroll-area', () => {
  const React = require('react');
  
  const createMockComponent = (displayName) => {
    const Component = React.forwardRef((props, ref) => 
      React.createElement('div', { ...props, ref })
    );
    Component.displayName = displayName;
    return Component;
  };
  
  const mockRoot = createMockComponent('ScrollAreaRoot');
  const mockViewport = createMockComponent('ScrollAreaViewport'); 
  const mockScrollbar = createMockComponent('ScrollAreaScrollbar');
  const mockThumb = createMockComponent('ScrollAreaThumb');
  const mockCorner = createMockComponent('ScrollAreaCorner');
  
  return {
    Root: mockRoot,
    Viewport: mockViewport,
    Scrollbar: mockScrollbar,
    ScrollAreaScrollbar: mockScrollbar, // Ensure both names point to same component
    Thumb: mockThumb,
    ScrollAreaThumb: mockThumb, // Ensure both names point to same component
    Corner: mockCorner
  };
});

// Mock Drizzle DB client to prevent actual database connections during tests
jest.mock('@/lib/db/drizzle-client', () => {
  const mockExecuteQuery = jest.fn(() => Promise.resolve([]));
  const mockExecuteTransaction = jest.fn((callback) => callback({
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    returning: jest.fn(() => Promise.resolve([])),
    execute: jest.fn(() => Promise.resolve([]))
  }));

  return {
    executeQuery: mockExecuteQuery,
    executeTransaction: mockExecuteTransaction,
    validateDatabaseConnection: jest.fn(() => Promise.resolve(true)),
    db: {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      returning: jest.fn(() => Promise.resolve([])),
      execute: jest.fn(() => Promise.resolve([]))
    }
  };
});