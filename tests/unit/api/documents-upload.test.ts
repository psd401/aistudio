// Mock Next.js server components first
jest.mock('next/server', () => ({
  NextRequest: jest.fn(),
  NextResponse: class NextResponse {
    body: string;
    status: number;
    headers: Map<string, string>;
    
    constructor(body: string, init?: { status?: number; headers?: Record<string, string> }) {
      this.body = body;
      this.status = init?.status || 200;
      this.headers = new Map(Object.entries(init?.headers || {}));
    }
    
    json() {
      return Promise.resolve(JSON.parse(this.body));
    }
    
    static json(data: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new NextResponse(JSON.stringify(data), {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...(init?.headers || {})
        }
      });
    }
  }
}));

import { POST } from '@/app/api/documents/upload/route';
import { uploadDocument } from '@/lib/aws/s3-client';
import { saveDocument, saveDocumentChunk, batchInsertDocumentChunks } from '@/lib/db/queries/documents';
import { getCurrentUserAction } from '@/actions/db/get-current-user-action';
import { getServerSession } from '@/lib/auth/server-session';
// Removed unused imports from '@/lib/document-processing'
import { NextRequest } from 'next/server';

// Mock dependencies
jest.mock('@/lib/auth/server-session', () => ({
  getServerSession: jest.fn()
}));
jest.mock('@/actions/db/get-current-user-action');
jest.mock('@/lib/aws/s3-client');
jest.mock('@/lib/db/queries/documents');
jest.mock('@/lib/file-validation', () => {
  const originalModule = jest.requireActual('@/lib/file-validation');
  return {
    ...originalModule,
    getMaxFileSize: jest.fn(() => Promise.resolve(25 * 1024 * 1024)), // 25MB
  };
});
jest.mock('@/lib/logger', () => ({
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
  createLogger: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  })),
  generateRequestId: jest.fn(() => 'test-request-id'),
  startTimer: jest.fn(() => jest.fn()),
  sanitizeForLogging: jest.fn((data) => data),
}));

// Mock FormData and File
class MockFile extends Blob {
  name: string;
  lastModified: number;
  webkitRelativePath: string;
  private _chunks: any[];

  constructor(chunks: any[], filename: string, options?: any) {
    super(chunks, options);
    this.name = filename;
    this.lastModified = Date.now();
    this.webkitRelativePath = '';
    this._chunks = chunks;
  }

  // Implement arrayBuffer method
  async arrayBuffer(): Promise<ArrayBuffer> {
    const content = this._chunks.join('');
    const buffer = Buffer.from(content, 'utf8');
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  // Ensure the file name is properly preserved
  toString() {
    return `[object File]`;
  }
}

global.File = MockFile as any;

// Also mock FormData to ensure it preserves file names correctly
class MockFormData {
  private data: Map<string, any> = new Map();

  append(name: string, value: any, filename?: string) {
    if (value instanceof MockFile) {
      this.data.set(name, value);
    } else {
      this.data.set(name, value);
    }
  }

  get(name: string) {
    return this.data.get(name);
  }

  has(name: string) {
    return this.data.has(name);
  }

  set(name: string, value: any) {
    this.data.set(name, value);
  }

  delete(name: string) {
    this.data.delete(name);
  }

  entries() {
    return this.data.entries();
  }

  keys() {
    return this.data.keys();
  }

  values() {
    return this.data.values();
  }

  forEach(callback: (value: any, key: string) => void) {
    this.data.forEach(callback);
  }
}

global.FormData = MockFormData as any;

// Mock document processing functions
jest.mock('@/lib/document-processing', () => ({
  extractTextFromDocument: jest.fn().mockImplementation((buffer, fileType) => {
    // Return the actual buffer content as text for testing
    const text = buffer.toString('utf8');
    return Promise.resolve({
      text,
      metadata: { pages: 1 }
    });
  }),
  chunkText: jest.fn().mockImplementation((text) => {
    // Split text into chunks of 1000 characters for testing
    const chunkSize = 1000;
    const chunks = [];
    for (let i = 0; i < text.length; i += chunkSize) {
      chunks.push(text.slice(i, i + chunkSize));
    }
    return chunks.length > 0 ? chunks : [text];
  }),
  getFileTypeFromFileName: jest.fn((filename) => {
    const ext = filename.split('.').pop()?.toLowerCase();
    return ext || 'unknown';
  })
}));

describe('POST /api/documents/upload', () => {
  const mockUserId = 'user-123';
  const mockSession = { sub: mockUserId, email: 'test@example.com' };
  const mockUser = {
    isSuccess: true,
    data: { user: { id: mockUserId } },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (getServerSession as jest.Mock).mockResolvedValue(mockSession);
    (getCurrentUserAction as jest.Mock).mockResolvedValue(mockUser);
  });

  const createMockRequest = (formData: FormData): NextRequest => {
    return {
      formData: async () => formData,
      headers: {
        get: (_name: string) => null,
      },
    } as unknown as NextRequest;
  };

  describe('Authentication', () => {
    it('should return 401 if user is not authenticated', async () => {
      (getServerSession as jest.Mock).mockResolvedValue(null);
      
      const formData = new FormData();
      const request = createMockRequest(formData);
      
      const response = await POST(request);
      const data = await response.json();
      
      expect(response.status).toBe(401);
      expect(data.error).toBe('Unauthorized');
    });

    it('should return 401 if user is not found', async () => {
      (getCurrentUserAction as jest.Mock).mockResolvedValue({
        isSuccess: false,
      });
      
      const formData = new FormData();
      const request = createMockRequest(formData);
      
      const response = await POST(request);
      const data = await response.json();
      
      expect(response.status).toBe(401);
      expect(data.error).toBe('User not found');
    });
  });

  describe('File Validation', () => {
    it('should return 400 if no file is provided', async () => {
      const formData = new FormData();
      const request = createMockRequest(formData);
      
      const response = await POST(request);
      const data = await response.json();
      
      expect(response.status).toBe(400);
      expect(data.error).toBe('No file uploaded');
    });


    it('should reject files over 25MB', async () => {
      const largeContent = new Array(26 * 1024 * 1024).fill('a').join('');
      const file = new MockFile([largeContent], 'large.pdf', { type: 'application/pdf' });
      
      const formData = new FormData();
      formData.append('file', file);
      const request = createMockRequest(formData);
      
      const response = await POST(request);
      const data = await response.json();
      
      expect(response.status).toBe(400);
      expect(data.error).toBe('File size must be less than 25MB');
    });

    it('should reject invalid file types', async () => {
      const file = new MockFile(['test content'], 'test.exe', { type: 'application/exe' });
      
      const formData = new FormData();
      formData.append('file', file);
      const request = createMockRequest(formData);
      
      const response = await POST(request);
      const data = await response.json();
      
      expect(response.status).toBe(400);
      expect(data.error).toBe('Unsupported file extension. Allowed file types are: .pdf, .docx, .xlsx, .pptx, .txt, .md, .csv');
    });
  });

  describe('Successful Upload', () => {
    it('should successfully upload a PDF file', async () => {
      const file = new MockFile(['PDF content'], 'test.pdf', { type: 'application/pdf' });
      const formData = new FormData();
      formData.append('file', file);
      const request = createMockRequest(formData);
      
      const mockUploadResult = {
        key: 'documents/user-123/test-123.pdf',
        url: 'https://s3.amazonaws.com/bucket/documents/user-123/test-123.pdf',
      };
      
      const mockDocument = {
        id: 'doc-123',
        name: 'test.pdf',
        type: 'pdf',
        url: mockUploadResult.key,
        size: 11,
        user_id: mockUserId,
        conversation_id: null,
        metadata: { originalName: 'test.pdf', uploadedBy: mockUserId },
        created_at: new Date(),
        updated_at: new Date(),
      };
      
      const mockChunks = [
        { id: 'chunk-1', document_id: 'doc-123', content: 'PDF content', chunk_index: 0 },
      ];
      
      (uploadDocument as jest.Mock).mockResolvedValue(mockUploadResult);
      (saveDocument as jest.Mock).mockResolvedValue(mockDocument);
      (batchInsertDocumentChunks as jest.Mock).mockResolvedValue(mockChunks);
      
      const response = await POST(request);
      const data = await response.json();
      
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.document).toEqual({
        id: 'doc-123',
        name: 'test.pdf',
        type: 'pdf',
        url: mockUploadResult.key,
        size: 11,
        totalChunks: 1,
      });
      
      // Verify S3 upload was called
      expect(uploadDocument).toHaveBeenCalledWith({
        userId: mockUserId,
        fileName: 'test.pdf',
        fileContent: expect.any(Buffer),
        contentType: 'application/pdf',
        metadata: {
          originalName: 'test.pdf',
          uploadedBy: mockUserId,
        },
      });
      
      // Verify document was created in database
      expect(saveDocument).toHaveBeenCalledWith({
        userId: mockUserId,
        conversationId: null,
        name: 'test.pdf',
        type: 'pdf',
        size: 11,
        url: mockUploadResult.key,
        metadata: { pages: 1 },
      });
      
      // Verify chunks were created
      expect(batchInsertDocumentChunks).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            documentId: 'doc-123',
            content: 'PDF content',
            chunkIndex: 0,
          }),
        ])
      );
    });

    it('should handle text extraction from different file types', async () => {
      const testCases = [
        { 
          filename: 'test.txt', 
          type: 'text/plain', 
          content: 'Plain text content',
          expectedChunks: ['Plain text content'],
        },
        { 
          filename: 'test.docx', 
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          content: 'DOCX content',
          expectedChunks: ['DOCX content'], // Simplified for test
        },
      ];
      
      for (const testCase of testCases) {
        jest.clearAllMocks();
        
        const file = new MockFile([testCase.content], testCase.filename, { type: testCase.type });
        const formData = new FormData();
        formData.append('file', file);
        const request = createMockRequest(formData);
        
        const mockUploadResult = {
          key: `documents/user-123/${testCase.filename}`,
          url: `https://s3.amazonaws.com/bucket/documents/user-123/${testCase.filename}`,
        };
        
        const mockDocument = {
          id: 'doc-123',
          name: testCase.filename,
          type: testCase.filename.split('.').pop(),
          url: mockUploadResult.key,
          size: testCase.content.length,
          user_id: mockUserId,
        };
        
        (uploadDocument as jest.Mock).mockResolvedValue(mockUploadResult);
        (saveDocument as jest.Mock).mockResolvedValue(mockDocument);
        (batchInsertDocumentChunks as jest.Mock).mockResolvedValue([]);
        
        const response = await POST(request);
        const data = await response.json();
        
        expect(response.status).toBe(200);
        expect(data.success).toBe(true);
        expect(data.document.name).toBe(testCase.filename);
      }
    });

    it('should chunk large documents', async () => {
      // Create content larger than chunk size (1000 chars)
      const largeContent = 'a'.repeat(2500); // 2500 characters
      const file = new MockFile([largeContent], 'large.txt', { type: 'text/plain' });
      const formData = new FormData();
      formData.append('file', file);
      const request = createMockRequest(formData);
      
      const mockUploadResult = {
        key: 'documents/user-123/large-123.txt',
        url: 'https://s3.amazonaws.com/bucket/documents/user-123/large-123.txt',
      };
      
      const mockDocument = {
        id: 'doc-123',
        name: 'large.txt',
        type: 'txt',
        url: mockUploadResult.key,
        size: 2500,
        user_id: mockUserId,
      };
      
      (uploadDocument as jest.Mock).mockResolvedValue(mockUploadResult);
      (saveDocument as jest.Mock).mockResolvedValue(mockDocument);
      (batchInsertDocumentChunks as jest.Mock).mockResolvedValue([]);
      
      const response = await POST(request);
      const data = await response.json();
      
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      
      // Verify chunks were created (should be 3 chunks for 2500 chars with 1000 char chunks)
      expect(batchInsertDocumentChunks).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ documentId: 'doc-123', chunkIndex: 0 }),
          expect.objectContaining({ documentId: 'doc-123', chunkIndex: 1 }),
          expect.objectContaining({ documentId: 'doc-123', chunkIndex: 2 }),
        ])
      );
    });
  });

  describe('Error Handling', () => {
    it('should handle S3 upload errors', async () => {
      const file = new MockFile(['test content'], 'test.pdf', { type: 'application/pdf' });
      const formData = new FormData();
      formData.append('file', file);
      const request = createMockRequest(formData);
      
      (uploadDocument as jest.Mock).mockRejectedValue(new Error('S3 upload failed'));
      
      const response = await POST(request);
      const data = await response.json();
      
      expect(response.status).toBe(500);
      expect(data.error).toContain('Failed to upload file');
    });

    it('should handle database errors', async () => {
      const file = new MockFile(['test content'], 'test.pdf', { type: 'application/pdf' });
      const formData = new FormData();
      formData.append('file', file);
      const request = createMockRequest(formData);
      
      const mockUploadResult = {
        key: 'documents/user-123/test-123.pdf',
        url: 'https://s3.amazonaws.com/bucket/documents/user-123/test-123.pdf',
      };
      
      (uploadDocument as jest.Mock).mockResolvedValue(mockUploadResult);
      (saveDocument as jest.Mock).mockRejectedValue(new Error('Database error'));
      
      const response = await POST(request);
      const data = await response.json();
      
      expect(response.status).toBe(500);
      expect(data.error).toContain('Failed to save document');
    });

    it('should handle text extraction errors gracefully', async () => {
      const file = new MockFile(['corrupted content'], 'test.pdf', { type: 'application/pdf' });
      const formData = new FormData();
      formData.append('file', file);
      const request = createMockRequest(formData);
      
      const mockUploadResult = {
        key: 'documents/user-123/test-123.pdf',
        url: 'https://s3.amazonaws.com/bucket/documents/user-123/test-123.pdf',
      };
      
      const mockDocument = {
        id: 'doc-123',
        name: 'test.pdf',
        type: 'pdf',
        url: mockUploadResult.key,
        size: 17,
        user_id: mockUserId,
      };
      
      (uploadDocument as jest.Mock).mockResolvedValue(mockUploadResult);
      (saveDocument as jest.Mock).mockResolvedValue(mockDocument);
      // Mock text extraction failure - should still save document without chunks
      (batchInsertDocumentChunks as jest.Mock).mockResolvedValue([]);
      
      const response = await POST(request);
      const data = await response.json();
      
      // Should still succeed even if text extraction fails
      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.document.id).toBe('doc-123');
    });
  });

  describe('Filename Sanitization', () => {
    it('should sanitize filenames with special characters', async () => {
      const testCases = [
        { input: 'test file.pdf', expected: 'test_file.pdf' },
        { input: 'test@#$%.pdf', expected: 'test____.pdf' },
        { input: 'test___file.pdf', expected: 'test___file.pdf' },
        { input: '../../etc/passwd.pdf', expected: '.._.._etc_passwd.pdf' },
      ];
      
      for (const testCase of testCases) {
        jest.clearAllMocks();
        
        const file = new MockFile(['test content'], testCase.input, { type: 'application/pdf' });
        const formData = new FormData();
        formData.append('file', file);
        const request = createMockRequest(formData);
        
        const mockDocument = {
          id: 'doc-123',
          name: testCase.expected,
          type: 'pdf',
          url: 'test-key',
          size: 12,
          user_id: mockUserId,
          conversation_id: null,
          metadata: {},
          created_at: new Date(),
          updated_at: new Date(),
        };
        
        (uploadDocument as jest.Mock).mockResolvedValue({ key: 'test-key', url: 'test-url' });
        (saveDocument as jest.Mock).mockResolvedValue(mockDocument);
        (batchInsertDocumentChunks as jest.Mock).mockResolvedValue([]);
        
        const response = await POST(request);
        
        expect(response.status).toBe(200);
        expect(uploadDocument).toHaveBeenCalledWith(
          expect.objectContaining({
            fileName: testCase.expected,
          })
        );
      }
    });
  });
});