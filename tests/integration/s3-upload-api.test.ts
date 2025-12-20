/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server'
import { POST as presignedUrlHandler } from '@/app/api/documents/presigned-url/route'
import { POST as processHandler } from '@/app/api/documents/process/route'

// Mock all dependencies
jest.mock('@/lib/auth/server-session')
jest.mock('@/actions/db/get-current-user-action')
jest.mock('@/lib/aws/s3-client')
jest.mock('@/lib/db/queries/documents')
jest.mock('@/lib/document-processing')
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  },
  createLogger: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  })),
  generateRequestId: jest.fn(() => 'test-request-id'),
  startTimer: jest.fn(() => jest.fn()),
  sanitizeForLogging: jest.fn((data) => data)
}))
jest.mock('@/lib/file-validation', () => ({
  ...jest.requireActual('@/lib/file-validation'),
  getMaxFileSize: jest.fn().mockResolvedValue(10 * 1024 * 1024) // 10MB
}))

// Import mocked modules
import { getServerSession } from '@/lib/auth/server-session'
import { getCurrentUserAction } from '@/actions/db/get-current-user-action'
import { generateUploadPresignedUrl, getObjectStream, documentExists } from '@/lib/aws/s3-client'
import { saveDocument, batchInsertDocumentChunks } from '@/lib/db/queries/documents'
import { extractTextFromDocument, chunkText } from '@/lib/document-processing'

const mockGetServerSession = getServerSession as jest.MockedFunction<typeof getServerSession>
const mockGetCurrentUserAction = getCurrentUserAction as jest.MockedFunction<typeof getCurrentUserAction>
const mockGenerateUploadPresignedUrl = generateUploadPresignedUrl as jest.MockedFunction<typeof generateUploadPresignedUrl>
const mockDocumentExists = documentExists as jest.MockedFunction<typeof documentExists>
const mockGetObjectStream = getObjectStream as jest.MockedFunction<typeof getObjectStream>
const mockExtractTextFromDocument = extractTextFromDocument as jest.MockedFunction<typeof extractTextFromDocument>
const mockChunkText = chunkText as jest.MockedFunction<typeof chunkText>
const mockSaveDocument = saveDocument as jest.MockedFunction<typeof saveDocument>
const mockBatchInsertDocumentChunks = batchInsertDocumentChunks as jest.MockedFunction<typeof batchInsertDocumentChunks>

describe('S3 Upload API Integration Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('POST /api/documents/presigned-url', () => {
    it('should return ActionState format with presigned URL data', async () => {
      // Mock authentication
      mockGetServerSession.mockResolvedValue({
        sub: 'test-cognito-sub',
        email: 'test@example.com',
        exp: 1234567890,
        iat: 1234567890
      })

      mockGetCurrentUserAction.mockResolvedValue({
        isSuccess: true,
        message: 'Success',
        data: {
          user: { id: 123, email: 'test@example.com', cognitoSub: 'test-sub-123', firstName: 'Test', lastName: 'User', lastSignInAt: new Date(), createdAt: new Date(), updatedAt: new Date(), oldClerkId: null, roleVersion: null },
          roles: [{ id: 1, name: 'student', description: 'Student role' }]
        }
      })

      // Mock S3 presigned URL generation
      mockGenerateUploadPresignedUrl.mockResolvedValue({
        url: 'https://s3.amazonaws.com/test-bucket/123/test.pdf',
        key: '123/test.pdf',
        fields: { 'x-amz-signature': 'test-signature' }
      })

      // Create request
      const request = new NextRequest('http://localhost:3000/api/documents/presigned-url', {
        method: 'POST',
        body: JSON.stringify({
          fileName: 'test.pdf',
          fileType: 'application/pdf',
          fileSize: 1024
        })
      })

      // Call handler
      const response = await presignedUrlHandler(request)
      const data = await response.json()

      // Verify response format is ActionState
      expect(data).toMatchObject({
        isSuccess: true,
        message: 'Presigned URL generated successfully',
        data: {
          url: 'https://s3.amazonaws.com/test-bucket/123/test.pdf',
          key: '123/test.pdf',
          fields: { 'x-amz-signature': 'test-signature' },
          expiresAt: expect.any(String)
        }
      })
    })

    it('should handle validation errors with ActionState format', async () => {
      // Mock authentication
      mockGetServerSession.mockResolvedValue({
        sub: 'test-cognito-sub',
        email: 'test@example.com',
        exp: 1234567890,
        iat: 1234567890
      })

      mockGetCurrentUserAction.mockResolvedValue({
        isSuccess: true,
        message: 'Success',
        data: {
          user: { id: 123, email: 'test@example.com', cognitoSub: 'test-sub-123', firstName: 'Test', lastName: 'User', lastSignInAt: new Date(), createdAt: new Date(), updatedAt: new Date(), oldClerkId: null, roleVersion: null },
          roles: [{ id: 1, name: 'student', description: 'Student role' }]
        }
      })

      // Create request with invalid data
      const request = new NextRequest('http://localhost:3000/api/documents/presigned-url', {
        method: 'POST',
        body: JSON.stringify({
          fileName: '', // Empty filename
          fileType: 'invalid/type',
          fileSize: -1 // Negative size
        })
      })

      // Call handler
      const response = await presignedUrlHandler(request)
      const data = await response.json()

      // Verify error response format
      expect(response.status).toBe(400)
      expect(data).toMatchObject({
        isSuccess: false,
        message: expect.any(String)
      })
    })
  })

  describe('POST /api/documents/process', () => {
    it('should return ActionState format with processed document data', async () => {
      // Mock authentication
      mockGetServerSession.mockResolvedValue({
        sub: 'test-cognito-sub',
        email: 'test@example.com',
        exp: 1234567890,
        iat: 1234567890
      })

      mockGetCurrentUserAction.mockResolvedValue({
        isSuccess: true,
        message: 'Success',
        data: {
          user: { id: 123, email: 'test@example.com', cognitoSub: 'test-sub-123', firstName: 'Test', lastName: 'User', lastSignInAt: new Date(), createdAt: new Date(), updatedAt: new Date(), oldClerkId: null, roleVersion: null },
          roles: [{ id: 1, name: 'student', description: 'Student role' }]
        }
      })

      // Mock S3 operations
      mockDocumentExists.mockResolvedValue(true)
      mockGetObjectStream.mockResolvedValue({
        stream: {
          [Symbol.asyncIterator]: async function* () {
            yield Buffer.from('test content')
          }
        } as any,
        metadata: { originalName: 'test.pdf' }
      })

      // Mock document processing
      mockExtractTextFromDocument.mockResolvedValue({
        text: 'Extracted text content',
        metadata: { pages: 1 }
      })
      mockChunkText.mockReturnValue(['chunk1', 'chunk2'])

      // Mock database operations
      mockSaveDocument.mockResolvedValue({
        id: 456,
        name: 'test.pdf',
        type: 'pdf',
        size: 1024,
        url: '123/test.pdf',
        userId: 123,
        conversationId: null,
        metadata: {},
        createdAt: new Date(),
        updatedAt: new Date()
      })
      mockBatchInsertDocumentChunks.mockResolvedValue([
        { id: 1, documentId: 456, content: 'chunk1', chunkIndex: 0, metadata: {}, createdAt: new Date(), updatedAt: new Date(), embedding: null, pageNumber: null },
        { id: 2, documentId: 456, content: 'chunk2', chunkIndex: 1, metadata: {}, createdAt: new Date(), updatedAt: new Date(), embedding: null, pageNumber: null }
      ])

      // Create request
      const request = new NextRequest('http://localhost:3000/api/documents/process', {
        method: 'POST',
        body: JSON.stringify({
          key: '123/test.pdf',
          fileName: 'test.pdf',
          fileSize: 1024,
          conversationId: null
        })
      })

      // Call handler
      const response = await processHandler(request)
      const data = await response.json()

      // Verify response format is ActionState
      expect(data).toMatchObject({
        isSuccess: true,
        message: 'Document processed successfully',
        data: {
          document: {
            id: 456,
            name: 'test.pdf',
            type: 'pdf',
            size: 1024,
            url: '123/test.pdf',
            totalChunks: 2
          }
        }
      })
    })

    it('should handle S3 key authorization errors', async () => {
      // Mock authentication
      mockGetServerSession.mockResolvedValue({
        sub: 'test-cognito-sub',
        email: 'test@example.com',
        exp: 1234567890,
        iat: 1234567890
      })

      mockGetCurrentUserAction.mockResolvedValue({
        isSuccess: true,
        message: 'Success',
        data: {
          user: { id: 123, email: 'test@example.com', cognitoSub: 'test-sub-123', firstName: 'Test', lastName: 'User', lastSignInAt: new Date(), createdAt: new Date(), updatedAt: new Date(), oldClerkId: null, roleVersion: null },
          roles: [{ id: 1, name: 'student', description: 'Student role' }]
        }
      })

      // Create request with wrong user ID in key
      const request = new NextRequest('http://localhost:3000/api/documents/process', {
        method: 'POST',
        body: JSON.stringify({
          key: '999/malicious.pdf', // Different user ID
          fileName: 'malicious.pdf',
          fileSize: 1024
        })
      })

      // Call handler
      const response = await processHandler(request)
      const data = await response.json()

      // Verify authorization error (401 because message contains "unauthorized")
      expect(response.status).toBe(401)
      expect(data).toMatchObject({
        isSuccess: false,
        message: 'Unauthorized access to document'
      })
    })
  })

  describe('Client Compatibility', () => {
    it('should maintain backward compatibility with existing client code', async () => {
      // Mock authentication
      mockGetServerSession.mockResolvedValue({
        sub: 'test-cognito-sub',
        email: 'test@example.com',
        exp: 1234567890,
        iat: 1234567890
      })

      mockGetCurrentUserAction.mockResolvedValue({
        isSuccess: true,
        message: 'Success',
        data: {
          user: { id: 123, email: 'test@example.com', cognitoSub: 'test-sub-123', firstName: 'Test', lastName: 'User', lastSignInAt: new Date(), createdAt: new Date(), updatedAt: new Date(), oldClerkId: null, roleVersion: null },
          roles: [{ id: 1, name: 'student', description: 'Student role' }]
        }
      })

      mockGenerateUploadPresignedUrl.mockResolvedValue({
        url: 'https://s3.amazonaws.com/test-bucket/123/test.pdf',
        key: '123/test.pdf',
        fields: {}
      })

      const request = new NextRequest('http://localhost:3000/api/documents/presigned-url', {
        method: 'POST',
        body: JSON.stringify({
          fileName: 'test.pdf',
          fileType: 'application/pdf',
          fileSize: 1024
        })
      })

      const response = await presignedUrlHandler(request)
      const data = await response.json()

      // Client code expects to access data.data.url or data.url
      expect(data.data?.url || data.url).toBe('https://s3.amazonaws.com/test-bucket/123/test.pdf')
      expect(data.data?.key || data.key).toBe('123/test.pdf')
    })
  })
})