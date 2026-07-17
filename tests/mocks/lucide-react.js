// Mock for lucide-react icons
const React = require('react');

module.exports = {
  Loader2: () => React.createElement('div', { className: 'mock-loader2', 'data-testid': 'loader2-icon' }),
  Info: () => React.createElement('div', { className: 'mock-info', 'data-testid': 'info-icon' }),
  AlertCircle: () => React.createElement('div', { className: 'mock-alert-circle', 'data-testid': 'alert-circle-icon' }),
  CheckCircle2: () => React.createElement('div', { className: 'mock-check-circle2', 'data-testid': 'check-circle2-icon' }),
  XCircle: () => React.createElement('div', { className: 'mock-x-circle', 'data-testid': 'x-circle-icon' }),
  // Icons used by DocumentUpload component
  FileTextIcon: () => React.createElement('div', { className: 'mock-file-text', 'data-testid': 'file-text-icon' }),
  XIcon: () => React.createElement('div', { className: 'mock-x', 'data-testid': 'x-icon' }),
  UploadIcon: () => React.createElement('div', { className: 'mock-upload', 'data-testid': 'upload-icon' }),
  CheckCircleIcon: () => React.createElement('div', { className: 'mock-check-circle', 'data-testid': 'check-circle-icon' }),
  RefreshCw: () => React.createElement('div', { className: 'mock-refresh-cw', 'data-testid': 'refresh-cw-icon' }),
  Upload: () => React.createElement('div', { className: 'mock-upload', 'data-testid': 'upload-icon' }),
  Activity: () => React.createElement('div', { className: 'mock-activity', 'data-testid': 'activity-icon' }),
  Save: () => React.createElement('div', { className: 'mock-save', 'data-testid': 'save-icon' }),
  // Add other icons as needed
};
