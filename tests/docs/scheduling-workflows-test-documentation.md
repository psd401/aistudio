# Scheduling Workflows Test Documentation

**Created for Issue #271: Testing: End-to-End Scheduling Workflows**

This document provides comprehensive documentation for the scheduling system testing suite, covering all aspects of schedule creation, execution, notification, and system reliability.

## Table of Contents

1. [Test Suite Overview](#test-suite-overview)
2. [Test Categories](#test-categories)
3. [Setup and Configuration](#setup-and-configuration)
4. [Running Tests](#running-tests)
5. [Test Scenarios](#test-scenarios)
6. [Performance Benchmarks](#performance-benchmarks)
7. [Accessibility Compliance](#accessibility-compliance)
8. [Troubleshooting](#troubleshooting)
9. [Contributing](#contributing)

## Test Suite Overview

The scheduling workflows testing suite provides comprehensive coverage of the AI Studio scheduling system, including:

- **End-to-End Workflows**: Complete user journeys from schedule creation to execution results
- **Integration Testing**: AWS service integrations (EventBridge, Lambda, SES)
- **Performance Testing**: Concurrent operations and system load testing
- **Error Handling**: Comprehensive failure scenario coverage
- **Accessibility Testing**: WCAG compliance and usability validation
- **Email Notifications**: SES integration and template validation

### Test File Structure

```
tests/
├── e2e/
│   ├── scheduling-workflows.spec.ts      # Complete E2E workflows
│   ├── accessibility-scheduling.spec.ts  # Accessibility compliance
│   └── schedule-modal.spec.ts           # Existing modal tests
├── integration/
│   ├── eventbridge-lambda-execution.test.ts  # AWS service integration
│   ├── email-notification-testing.test.ts    # Email delivery testing
│   └── error-handling-scenarios.test.ts      # Error and failure scenarios
├── performance/
│   └── concurrent-schedules.test.ts      # Performance and load testing
└── docs/
    └── scheduling-workflows-test-documentation.md  # This file
```

## Test Categories

### 1. End-to-End (E2E) Tests

**File**: `tests/e2e/scheduling-workflows.spec.ts`

Tests complete user workflows including:
- Schedule creation with different frequencies (daily, weekly, monthly, custom)
- Schedule management (edit, pause, resume, delete)
- Execution triggering and result viewing
- Form validation and error handling
- Cross-browser compatibility

**Key Test Cases**:
- Complete schedule creation to execution workflow
- Weekly schedule configuration with day selection
- Monthly schedule with day-of-month settings
- Custom cron expression validation
- Schedule editing and deletion workflows

### 2. Integration Tests

#### AWS Service Integration
**File**: `tests/integration/eventbridge-lambda-execution.test.ts`

Tests AWS service integrations:
- EventBridge schedule creation and management
- Lambda function execution simulation
- Execution result storage and retrieval
- Service failure handling

#### Email Notification Testing
**File**: `tests/integration/email-notification-testing.test.ts`

Tests email delivery system:
- SES integration and email sending
- HTML and text email template rendering
- Email attachment handling (markdown files)
- Delivery failure retry logic
- User notification preferences

#### Error Handling
**File**: `tests/integration/error-handling-scenarios.test.ts`

Comprehensive error scenario coverage:
- Authentication and authorization failures
- Input validation errors
- Database connection issues
- External service failures
- Data corruption recovery

### 3. Performance Tests

**File**: `tests/performance/concurrent-schedules.test.ts`

Performance and scalability testing:
- Concurrent schedule creation (50+ simultaneous)
- Mixed CRUD operation performance
- Database query performance under load
- Memory usage monitoring
- Sustained load testing

### 4. Accessibility Tests

**File**: `tests/e2e/accessibility-scheduling.spec.ts`

WCAG compliance and accessibility validation:
- Keyboard navigation support
- Screen reader compatibility
- Color contrast compliance
- Form labeling and associations
- Mobile and touch accessibility

## Setup and Configuration

### Prerequisites

1. **Node.js** version 18+ with npm
2. **PostgreSQL** database (test environment)
3. **AWS credentials** configured for test environment
4. **Playwright** browsers installed

### Environment Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Install Playwright browsers**:
   ```bash
   bunx playwright install
   ```

3. **Configure test environment variables**:
   ```bash
   cp .env.example .env.test
   # Edit .env.test with test-specific values
   ```

4. **Database setup**:
   ```bash
   # Run database migrations
   npm run db:migrate:test

   # Seed test data
   npm run db:seed:test
   ```

### Test Data Requirements

The tests require:
- At least one test user account
- One or more assistant architect configurations
- Test email addresses for notification testing
- Mock AWS service configurations

## Running Tests

### Individual Test Suites

```bash
# Run all scheduling workflow tests
npm run test:e2e:scheduling

# Run integration tests
npm run test:integration:scheduling

# Run performance tests
npm run test:performance:scheduling

# Run accessibility tests
npm run test:accessibility:scheduling
```

### Complete Test Suite

```bash
# Run all scheduling-related tests
npm run test:scheduling:all

# Run with coverage reporting
npm run test:scheduling:coverage

# Run in CI mode
npm run test:scheduling:ci
```

### Test Environment Options

```bash
# Run tests in headed mode (see browser)
npm run test:e2e:scheduling -- --headed

# Run specific test file
bunx playwright test tests/e2e/scheduling-workflows.spec.ts

# Run with debug mode
bunx playwright test --debug tests/e2e/scheduling-workflows.spec.ts

# Run tests against specific environment
ENVIRONMENT=staging npm run test:e2e:scheduling
```

## Test Scenarios

### Happy Path Scenarios

1. **Complete Schedule Creation Workflow**
   - User selects assistant architect
   - Opens schedule modal
   - Fills in schedule configuration
   - Submits and verifies creation
   - Checks schedule appears in list
   - Verifies next execution time

2. **Schedule Execution and Results**
   - Manual schedule execution
   - Result data validation
   - Email notification delivery
   - Result file download
   - Execution history tracking

3. **Schedule Management Operations**
   - Edit schedule configuration
   - Pause and resume schedules
   - Delete schedules with confirmation
   - Bulk operations on multiple schedules

### Error Scenarios

1. **Validation Failures**
   - Empty required fields
   - Invalid time formats
   - Malformed cron expressions
   - Oversized input data
   - Invalid frequency configurations

2. **Authorization Issues**
   - Unauthenticated access attempts
   - Insufficient permissions
   - Access to unauthorized resources
   - Session expiration handling

3. **Infrastructure Failures**
   - Database connection timeouts
   - EventBridge service unavailability
   - Lambda execution failures
   - SES delivery failures
   - Network connectivity issues

### Performance Scenarios

1. **Concurrent Operations**
   - 50+ simultaneous schedule creations
   - Mixed CRUD operations under load
   - Database query optimization validation
   - Memory usage stability

2. **Scalability Testing**
   - Increasing load patterns
   - Resource consumption monitoring
   - Response time degradation analysis
   - System recovery testing

## Performance Benchmarks

### Expected Performance Metrics

| Operation | Target Time | Concurrent Load | Success Rate |
|-----------|-------------|-----------------|--------------|
| Schedule Creation | < 1 second | 50 concurrent | > 99% |
| Schedule Retrieval | < 500ms | 20 concurrent | > 99.9% |
| Schedule Update | < 800ms | 25 concurrent | > 98% |
| Schedule Deletion | < 600ms | 15 concurrent | > 99% |
| Email Delivery | < 5 seconds | 10 concurrent | > 95% |

### Performance Test Monitoring

The performance tests monitor:
- **Response Times**: P50, P95, P99 percentiles
- **Throughput**: Operations per second
- **Error Rates**: Failed operations percentage
- **Resource Usage**: Memory, CPU, database connections
- **Recovery Time**: Time to recover from failures

## Accessibility Compliance

### WCAG 2.1 Requirements

The accessibility tests validate:

1. **Level A Compliance**
   - Keyboard navigation support
   - Alternative text for images
   - Proper heading hierarchy
   - Form field labeling

2. **Level AA Compliance**
   - Color contrast ratios (4.5:1 minimum)
   - Text resize up to 200%
   - Focus visibility
   - Error identification and suggestions

### Accessibility Test Coverage

- **Keyboard Navigation**: Tab order, keyboard shortcuts, focus management
- **Screen Reader Support**: ARIA labels, landmarks, live regions
- **Visual Design**: Color contrast, focus indicators, zoom support
- **Mobile Accessibility**: Touch target sizes, responsive design
- **Form Accessibility**: Field labeling, error messaging, grouping

## Troubleshooting

### Common Test Failures

1. **Test Environment Issues**
   ```bash
   # Reset test database
   npm run db:reset:test

   # Clear browser state
   bunx playwright test --project=chromium --reset-state
   ```

2. **AWS Service Connectivity**
   ```bash
   # Verify AWS credentials
   aws sts get-caller-identity

   # Check service availability
   aws eventbridge list-rules --region us-east-1
   ```

3. **Email Testing Issues**
   ```bash
   # Verify SES configuration
   aws ses get-send-statistics

   # Check email deliverability
   aws ses get-account-sending-enabled
   ```

### Debug Modes

```bash
# Run with detailed logging
DEBUG=pw:api npm run test:e2e:scheduling

# Run with video recording
npm run test:e2e:scheduling -- --video=on

# Run with tracing enabled
npm run test:e2e:scheduling -- --trace=on
```

### Test Data Cleanup

```bash
# Clean up test schedules
npm run test:cleanup:schedules

# Reset test user data
npm run test:cleanup:users

# Full test environment reset
npm run test:cleanup:all
```

## Performance Monitoring

### Metrics Collection

The test suite collects:
- **Execution Times**: Per operation and total workflow
- **Memory Usage**: Heap usage, garbage collection events
- **Database Performance**: Query times, connection pool usage
- **Network Latency**: API response times, external service calls

### Reporting

Performance results are reported in:
- **Console Output**: Real-time metrics during test execution
- **JSON Reports**: Structured data for CI/CD integration
- **HTML Dashboard**: Visual performance trend analysis
- **Alerts**: Automatic notifications for performance regressions

## Contributing

### Adding New Tests

1. **Identify Test Category**: Choose appropriate test type (E2E, integration, performance, accessibility)

2. **Follow Naming Conventions**:
   ```typescript
   // E2E tests
   test('should complete [workflow name] successfully', async ({ page }) => {

   // Integration tests
   test('should handle [integration scenario]', async () => {

   // Performance tests
   test('should maintain performance with [load scenario]', async () => {
   ```

3. **Include Proper Setup/Cleanup**:
   ```typescript
   test.beforeEach(async ({ page }) => {
     // Setup test environment
   })

   test.afterEach(async ({ page }) => {
     // Cleanup test data
   })
   ```

### Test Quality Guidelines

1. **Test Independence**: Each test should be independent and not rely on other tests
2. **Data Isolation**: Use unique test data to avoid conflicts
3. **Error Handling**: Include proper error handling and informative failure messages
4. **Performance Awareness**: Monitor test execution time and resource usage
5. **Documentation**: Include clear descriptions and comments for complex test logic

### Code Review Checklist

- [ ] Test covers the intended functionality completely
- [ ] Proper error handling and edge cases included
- [ ] Performance implications considered
- [ ] Accessibility requirements validated
- [ ] Test data cleanup implemented
- [ ] Documentation updated
- [ ] CI/CD integration verified

## Test Maintenance

### Regular Maintenance Tasks

1. **Monthly**:
   - Review test performance metrics
   - Update test data and configurations
   - Verify browser compatibility
   - Check accessibility compliance

2. **Quarterly**:
   - Performance benchmark updates
   - Test suite optimization
   - Documentation review
   - Tool and dependency updates

3. **As Needed**:
   - New feature test coverage
   - Bug reproduction tests
   - Production issue investigation
   - Regression test additions

### Monitoring and Alerts

Set up monitoring for:
- Test execution success rates
- Performance regression detection
- Infrastructure availability
- Test environment health
- Coverage metrics tracking

## Conclusion

This comprehensive test suite ensures the reliability, performance, and accessibility of the AI Studio scheduling system. Regular execution of these tests provides confidence in system quality and helps maintain high standards for user experience.

For questions or issues with the test suite, please refer to the project's main documentation or contact the development team.

---

*Last Updated: January 2025*
*Version: 1.0*
*Issue: #271 - Testing: End-to-End Scheduling Workflows*