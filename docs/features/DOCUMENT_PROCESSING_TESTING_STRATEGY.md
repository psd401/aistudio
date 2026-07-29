# Document Processing Pipeline Testing Strategy

## Executive Summary

After 8+ hours of implementing image uploads and the unified document processing architecture (Issue #210), we now need a comprehensive testing strategy to validate all document processing capabilities including:

- Standard document processing (PDF, DOCX, XLSX, PPTX)
- Text extraction and chunking
- Embedding generation
- LLM processing and markdown conversion
- OCR capabilities via Textract
- Client/server hybrid processing
- Multi-size file handling (up to 500MB)

## Current Implementation Status

### ✅ What's Already Implemented

Based on commit analysis and code review:

1. **Core Infrastructure**
   - Document Processing Stack with DynamoDB, S3, SQS, Lambda
   - API routes: initiate-upload, jobs/[jobId], confirm-upload, complete-multipart
   - Hybrid attachment adapters with client/server routing
   - Multi-strategy document processors (PDF, Office, Text)
   - Progress tracking and polling system

2. **Processing Capabilities**
   - PDF: pdf-parse → Textract OCR → Vision LLM fallback
   - Office: mammoth (DOCX), xlsx library (Excel/CSV)
   - Text: Markdown, JSON, XML, plain text
   - Image: Vision-capable adapters for GPT-4V, Claude 3, Gemini

3. **Test Coverage**
   - Unit tests for API routes and service contracts (`documents-v2.test.ts`,
     `documents-v2-server-upload.test.ts`)
   - Mock AWS service interactions
   - Integration workflow tests

### 🧪 What Needs Testing

1. **End-to-End Document Workflows**
2. **Processing Quality & Accuracy**
3. **Performance & Scalability**
4. **Error Handling & Recovery**
5. **Security & Validation**

## Testing Strategy Overview

### Phase 1: Infrastructure Validation (Priority: Critical)
**Timeline: Day 1**

Test the core plumbing before document-specific functionality.

#### 1.1 AWS Services Integration
```bash
# Test database connectivity
npm run test -- tests/integration/database-connection.test.ts

# Test S3 bucket permissions and CORS
npm run test -- tests/integration/s3-integration.test.ts

# Test SQS queue processing
npm run test -- tests/integration/sqs-processing.test.ts

# Test DynamoDB job tracking
npm run test -- tests/integration/dynamodb-jobs.test.ts
```

#### 1.2 API Route Health Checks
```bash
# Test all v2 API routes with minimal payloads
npm run test -- tests/integration/api-routes-health.test.ts
```

**Expected Results:**
- All AWS services accessible
- API routes return proper HTTP status codes
- Database schemas match expectations
- Queue messages flow correctly

### Phase 2: Document Type Processing (Priority: High)
**Timeline: Day 2-3**

Test each document type individually with known good files.

#### 2.1 PDF Processing Pipeline
```bash
# Create test with multiple PDF types
npm run test -- tests/integration/pdf-processing.test.ts
```

**Test Cases:**
- **Text-based PDF**: Simple text extraction with pdf-parse
- **Scanned PDF**: OCR via Textract (test free tier limits)
- **Mixed PDF**: Text + images requiring multiple strategies
- **Large PDF**: >50MB file testing high-memory processor
- **Complex PDF**: Forms, tables, multiple columns

#### 2.2 Office Document Processing
```bash
npm run test -- tests/integration/office-processing.test.ts
```

**Test Cases:**
- **DOCX**: Simple and complex formatting
- **XLSX**: Multiple sheets, formulas, charts
- **PPTX**: Slide text extraction
- **Legacy formats**: .doc, .xls, .ppt if supported

#### 2.3 Text Format Processing
```bash
npm run test -- tests/integration/text-processing.test.ts
```

**Test Cases:**
- **Markdown**: Headers, links, code blocks
- **JSON**: Nested structures, arrays
- **XML**: Structured data extraction
- **CSV**: Various delimiters, quoted fields
- **Plain text**: Large files, special characters

#### 2.4 Image Processing Validation
```bash
npm run test -- tests/integration/image-processing.test.ts
```

**Test Cases:**
- **Vision models**: GPT-4V, Claude 3, Gemini Pro Vision
- **File formats**: JPEG, PNG, WebP, GIF
- **Size limits**: Up to 20MB
- **Base64 encoding**: Proper data URL format

### Phase 3: Workflow Integration (Priority: High)
**Timeline: Day 4**

Test complete workflows as they would be used in production.

#### 3.1 Nexus Chat Integration
```bash
npm run test:e2e -- tests/e2e/nexus-document-upload.spec.ts
```

**User Workflows:**
1. Small file (<10MB): Upload → immediate processing → response
2. Large file (>10MB): Upload → S3 → queue → poll → response
3. Mixed conversation: Text + document + follow-up questions
4. Error recovery: Failed upload, processing timeout, retry logic

#### 3.2 Assistant Architect Integration
```bash
npm run test:e2e -- tests/e2e/assistant-architect-documents.spec.ts
```

**Repository Workflows:**
1. PDF upload → text extraction → embedding generation
2. Multi-document upload → batch processing
3. Document search and retrieval
4. Repository-specific processing options

#### 3.3 Repository Manager Integration
```bash
npm run test:e2e -- tests/e2e/repository-manager.spec.ts
```

**RAG Workflows:**
1. Document ingestion → chunking → embedding → search
2. Large document sets → batch processing
3. Document updates → re-processing
4. Search accuracy validation

### Phase 4: Performance & Scale Testing (Priority: Medium)
**Timeline: Day 5**

Validate performance characteristics and limits.

#### 4.1 File Size Testing
Create test suite with files of varying sizes:
```typescript
const testFiles = [
  { size: '1MB', type: 'pdf', expected: '<5s' },
  { size: '10MB', type: 'pdf', expected: '<15s' },
  { size: '50MB', type: 'pdf', expected: '<60s' },
  { size: '100MB', type: 'pdf', expected: '<120s' },
  { size: '500MB', type: 'pdf', expected: '<300s' },  // Max size
];
```

#### 4.2 Concurrent Processing
```bash
npm run test -- tests/performance/concurrent-uploads.test.ts
```

**Test Scenarios:**
- 10 simultaneous small files
- 5 simultaneous large files  
- Mixed sizes under load
- Queue backup and recovery

#### 4.3 Memory Usage Validation
Monitor Lambda memory usage during processing:
- Standard processor (3GB) limits
- High-memory processor (10GB) usage
- Memory leaks during long-running jobs

### Phase 5: Error Handling & Edge Cases (Priority: Medium)
**Timeline: Day 6**

Test failure modes and recovery mechanisms.

#### 5.1 File Format Edge Cases
```bash
npm run test -- tests/integration/edge-cases.test.ts
```

**Test Cases:**
- Corrupted files
- Password-protected documents
- Unsupported file types
- Files with special characters in names
- Zero-byte files
- Files exceeding size limits

#### 5.2 Processing Failures
**Scenarios:**
- Textract API limits exceeded
- S3 upload failures
- DynamoDB throttling
- Lambda timeouts
- Network interruptions

#### 5.3 Security Validation
```bash
npm run test -- tests/security/document-security.test.ts
```

**Test Cases:**
- Malicious file uploads
- Path traversal attempts
- Large file DoS attempts
- Unauthorized access attempts
- Data leakage prevention

### Phase 6: Production Readiness (Priority: Medium)
**Timeline: Day 7**

Validate monitoring, logging, and operational aspects.

#### 6.1 Monitoring & Alerting
- CloudWatch dashboard functionality
- Error rate alerts
- Performance metric collection
- Log aggregation and searchability

#### 6.2 Cost Optimization
- Textract usage tracking
- S3 storage costs
- Lambda execution costs
- DynamoDB read/write units

## Test Execution Plan

### Priority 1: Critical Path (Execute First)
1. **Infrastructure Validation** - Ensure basic plumbing works
2. **PDF Processing** - Most common and complex document type
3. **Nexus Chat Integration** - Primary user-facing feature

### Priority 2: Core Features (Execute Second)  
1. **Office Document Processing** - Common business documents
2. **Text Format Processing** - Developer and technical documents
3. **Assistant Architect Integration** - Repository features

### Priority 3: Polish & Scale (Execute Third)
1. **Performance Testing** - Validate at scale
2. **Error Handling** - Edge cases and failures
3. **Security Testing** - Malicious inputs and attacks

## Implementation Approach

### 1. Create Test Document Library
```bash
mkdir -p tests/fixtures/documents/{pdf,office,text,images}
```

**Document Types Needed:**
- `simple.pdf` - Text-based PDF (1MB)
- `scanned.pdf` - Image-based PDF requiring OCR (5MB)
- `large.pdf` - Large complex document (100MB)
- `document.docx` - Standard Word document
- `spreadsheet.xlsx` - Excel with multiple sheets
- `presentation.pptx` - PowerPoint slides
- `data.csv` - CSV with complex data
- `README.md` - Markdown with formatting
- `config.json` - Nested JSON structure
- `test-image.jpg` - Sample image for vision testing

### 2. Test Environment Setup
```typescript
// tests/setup/document-processing-setup.ts
export const setupDocumentProcessingTests = async () => {
  // Ensure test database is clean
  // Create test S3 buckets if needed
  // Configure test queues
  // Set up CloudWatch log groups
};
```

### 3. Test Utilities
```typescript
// tests/utils/document-testing-utils.ts
export const uploadTestDocument = async (file: Buffer, options: UploadOptions) => {
  // Standard document upload flow
};

export const waitForProcessingCompletion = async (jobId: string, timeout = 300000) => {
  // Poll job status until completion
};

export const validateProcessingResult = (result: ProcessingResult, expectedContent: string) => {
  // Validate text extraction quality
  // Check embedding generation
  // Verify markdown conversion
};
```

### 4. Performance Monitoring
```typescript
// tests/utils/performance-monitor.ts
export const measureProcessingTime = async (testFn: () => Promise<void>) => {
  // Track execution time
  // Monitor memory usage
  // Log performance metrics
};
```

## Success Criteria

### Functional Requirements
- [ ] All document types process successfully (95%+ success rate)
- [ ] Text extraction accuracy >90% for text-based documents
- [ ] OCR fallback works for scanned documents
- [ ] Image processing integrates with vision models
- [ ] Real-time progress tracking functions correctly
- [ ] Error messages are user-friendly and actionable

### Performance Requirements
- [ ] Files <10MB process in <15 seconds
- [ ] Files <50MB process in <2 minutes
- [ ] Files <500MB process in <5 minutes
- [ ] System handles 10 concurrent uploads
- [ ] 99.9% uptime during normal operation

### Security Requirements
- [ ] File type validation prevents malicious uploads
- [ ] User access is properly scoped
- [ ] No sensitive data leakage in logs
- [ ] Processing timeouts prevent DoS
- [ ] Error messages don't expose internal details

### Integration Requirements
- [ ] Nexus chat displays attachments correctly
- [ ] Assistant Architect processes repository documents
- [ ] Repository Manager enables document search
- [ ] All systems maintain data consistency

## Recommended Execution Order

### Week 1: Foundation
- **Day 1**: Infrastructure validation + Basic PDF processing
- **Day 2**: Office documents + Text formats
- **Day 3**: Full Nexus integration testing

### Week 2: Refinement  
- **Day 1**: Assistant Architect + Repository Manager
- **Day 2**: Performance + Scale testing
- **Day 3**: Error handling + Security

### Testing Commands Reference

```bash
# Run all document processing tests
npm run test:document-processing

# Run specific test suites
npm run test -- tests/integration/pdf-processing.test.ts
npm run test -- tests/e2e/nexus-document-upload.spec.ts

# Run performance tests
npm run test:performance

# Generate test coverage report
npm run test:coverage

# Run security tests
npm run test:security
```

## Next Steps

1. **Create test fixtures**: Gather representative documents of each type
2. **Implement Phase 1 tests**: Start with infrastructure validation
3. **Set up monitoring**: Configure CloudWatch dashboards for test runs
4. **Document results**: Track issues and performance metrics
5. **Iterate rapidly**: Fix issues as they're discovered

This strategy ensures comprehensive validation of the document processing pipeline while maintaining focus on the most critical user workflows first.
