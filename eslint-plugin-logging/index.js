/**
 * Custom ESLint Plugin for Logging Standards Enforcement
 * 
 * This plugin enforces mandatory logging patterns across the codebase:
 * - No console usage in server code
 * - Request ID generation in all server actions
 * - Proper error handling with typed errors
 * - No generic error messages
 */

module.exports = {
  rules: {
    /**
     * Rule: no-console-in-server
     * Prevents use of console.log, console.error, etc. in server-side code
     * Must use the logger from @/lib/logger instead
     */
    'no-console-in-server': {
      meta: {
        type: 'problem',
        docs: {
          description: 'Disallow console.log in server actions and API routes - use logger instead',
          category: 'Best Practices',
        },
        fixable: null,
        schema: [],
        messages: {
          noConsole: 'Use logger from @/lib/logger instead of console.{{method}}. Import with: import { createLogger } from "@/lib/logger"',
        },
      },
      create(context) {
        return {
          MemberExpression(node) {
            const filename = context.getFilename();
            
            // Only apply to server-side code
            if (!filename.includes('/actions/') && 
                !filename.includes('/app/api/') &&
                !filename.includes('/lib/db/') &&
                !filename.includes('/lib/auth/')) {
              return;
            }
            
            // Skip test files
            if (filename.includes('.test.') || filename.includes('.spec.')) {
              return;
            }

            // Skip env-validation.ts (Edge Runtime compatibility)
            if (filename.includes('env-validation.ts')) {
              return;
            }
            
            if (
              node.object.name === 'console' &&
              ['log', 'error', 'warn', 'info', 'debug'].includes(node.property.name)
            ) {
              context.report({
                node,
                messageId: 'noConsole',
                data: {
                  method: node.property.name,
                },
              });
            }
          },
        };
      },
    },

    /**
     * Rule: require-request-id
     * Ensures all server actions generate a request ID for tracing
     */
    'require-request-id': {
      meta: {
        type: 'problem',
        docs: {
          description: 'Require request ID generation in server actions and API routes',
          category: 'Best Practices',
        },
        schema: [],
        messages: {
          missingRequestId: 'Server actions must generate a request ID using generateRequestId() from @/lib/logger',
          missingImport: 'Must import generateRequestId from @/lib/logger',
        },
      },
      create(context) {
        let hasGenerateRequestIdImport = false;
        let hasRequestIdGeneration = false;
        let usesWithErrorHandling = false;
        let usesWithApiAuth = false;
        let usesCreateAuthHandlers = false;
        let isServerAction = false;
        let isApiRoute = false;

        const filename = context.getFilename();
        
        // Skip NextAuth routes
        if (filename.includes('[...nextauth]')) {
          return {};
        }
        
        // Check if this is a server action or API route
        if (filename.includes('/actions/') || filename.includes('.actions.')) {
          isServerAction = true;
        }
        if (filename.includes('/app/api/') && filename.includes('route.')) {
          isApiRoute = true;
        }

        return {
          ImportDeclaration(node) {
            if (node.source.value === '@/lib/logger') {
              const specifiers = node.specifiers;
              for (const spec of specifiers) {
                if (spec.type === 'ImportSpecifier' && spec.imported && spec.imported.name === 'generateRequestId') {
                  hasGenerateRequestIdImport = true;
                }
              }
            }
            // Check if using withErrorHandling from api-utils
            if (node.source.value === '@/lib/api-utils') {
              const specifiers = node.specifiers;
              for (const spec of specifiers) {
                if (spec.type === 'ImportSpecifier' && spec.imported && spec.imported.name === 'withErrorHandling') {
                  usesWithErrorHandling = true;
                }
              }
            }
            // Check if using withApiAuth (generates requestId internally)
            if (node.source.value === '@/lib/api' || node.source.value === '@/lib/api/with-api-auth') {
              const specifiers = node.specifiers;
              for (const spec of specifiers) {
                if (spec.type === 'ImportSpecifier' && spec.imported && spec.imported.name === 'withApiAuth') {
                  usesWithApiAuth = true;
                }
              }
            }
            // Check if using createAuthHandlers (NextAuth)
            if (node.source.value === '@/auth') {
              const specifiers = node.specifiers;
              for (const spec of specifiers) {
                if (spec.type === 'ImportSpecifier' && spec.imported && spec.imported.name === 'createAuthHandlers') {
                  usesCreateAuthHandlers = true;
                }
              }
            }
          },
          CallExpression(node) {
            if (node.callee.name === 'generateRequestId') {
              hasRequestIdGeneration = true;
            }
            if (node.callee.name === 'withErrorHandling') {
              usesWithErrorHandling = true;
            }
          },
          'Program:exit'() {
            // Skip if using createAuthHandlers (NextAuth)
            if (usesCreateAuthHandlers) {
              return;
            }
            
            // Skip if using withErrorHandling as it handles logging
            if (usesWithErrorHandling) {
              return;
            }

            // Skip if using withApiAuth as it generates requestId internally
            if (usesWithApiAuth) {
              return;
            }
            
            if ((isServerAction || isApiRoute) && !context.getFilename().includes('.test.')) {
              if (!hasGenerateRequestIdImport) {
                context.report({
                  node: context.getSourceCode().ast,
                  messageId: 'missingImport',
                });
              }
              if (!hasRequestIdGeneration) {
                context.report({
                  node: context.getSourceCode().ast,
                  messageId: 'missingRequestId',
                });
              }
            }
          },
        };
      },
    },

    /**
     * Rule: require-timer
     * Ensures all server actions use performance timers
     */
    'require-timer': {
      meta: {
        type: 'problem',
        docs: {
          description: 'Require performance timer in server actions',
          category: 'Performance',
        },
        schema: [],
        messages: {
          missingTimer: 'Server actions must use startTimer() from @/lib/logger for performance tracking',
          missingTimerCall: 'Timer must be called with timer({ status: "success" }) or timer({ status: "error" })',
        },
      },
      create(context) {
        let hasStartTimerImport = false;
        let hasTimerCreation = false;
        let hasTimerCall = false;
        let isServerAction = false;

        const filename = context.getFilename();
        if (filename.includes('/actions/') || filename.includes('.actions.')) {
          isServerAction = true;
        }

        return {
          ImportDeclaration(node) {
            if (node.source.value === '@/lib/logger') {
              const specifiers = node.specifiers;
              for (const spec of specifiers) {
                if (spec.imported && spec.imported.name === 'startTimer') {
                  hasStartTimerImport = true;
                }
              }
            }
          },
          CallExpression(node) {
            if (node.callee.name === 'startTimer') {
              hasTimerCreation = true;
            }
            // Check for timer() call
            if (node.callee.name === 'timer') {
              hasTimerCall = true;
            }
            // Also check for variable.timer() pattern
            if (node.callee.type === 'MemberExpression' && 
                node.callee.property.name === 'timer') {
              hasTimerCall = true;
            }
          },
          'Program:exit'() {
            if (isServerAction && !context.getFilename().includes('.test.')) {
              if (hasStartTimerImport && !hasTimerCreation) {
                context.report({
                  node: context.getSourceCode().ast,
                  messageId: 'missingTimer',
                });
              }
              if (hasTimerCreation && !hasTimerCall) {
                context.report({
                  node: context.getSourceCode().ast,
                  messageId: 'missingTimerCall',
                });
              }
            }
          },
        };
      },
    },

    /**
     * Rule: no-generic-error-messages
     * Prevents generic error messages like "DB error" or "Error occurred"
     */
    'no-generic-error-messages': {
      meta: {
        type: 'problem',
        docs: {
          description: 'Disallow generic error messages',
          category: 'Best Practices',
        },
        schema: [],
        messages: {
          genericError: 'Use specific, actionable error messages instead of "{{message}}". Example: "Failed to load user data. Please try again or contact support."',
        },
      },
      create(context) {
        const genericMessages = [
          'db error',
          'database error',
          'error occurred',
          'an error occurred',
          'something went wrong',
          'unknown error',
          'error',
          'failed',
          'operation failed',
          'request failed'
        ];

        return {
          Literal(node) {
            if (typeof node.value !== 'string') return;
            
            const filename = context.getFilename();
            
            // Skip test files
            if (filename.includes('.test.') || filename.includes('.spec.')) {
              return;
            }

            const lowerValue = node.value.toLowerCase().trim();
            
            for (const generic of genericMessages) {
              if (lowerValue === generic) {
                // Check if this is in a user-facing message context
                const parent = node.parent;
                if (parent && (
                  (parent.type === 'Property' && parent.key.name === 'message') ||
                  (parent.type === 'CallExpression' && parent.callee.name === 'handleError')
                )) {
                  context.report({
                    node,
                    messageId: 'genericError',
                    data: {
                      message: node.value,
                    },
                  });
                  break;
                }
              }
            }
          },
        };
      },
    },

    /**
     * Rule: use-error-factories
     * Encourages use of ErrorFactories instead of plain Error
     */
    'use-error-factories': {
      meta: {
        type: 'suggestion',
        docs: {
          description: 'Use typed errors from ErrorFactories instead of plain Error',
          category: 'Best Practices',
        },
        schema: [],
        messages: {
          useTypedError: 'Use ErrorFactories.{{suggestion}}() instead of throwing plain Error. Import with: import { ErrorFactories } from "@/lib/error-utils"',
          suggestions: {
            auth: 'authNoSession, authExpiredSession, authInvalidToken',
            db: 'dbQueryFailed, dbRecordNotFound, dbDuplicateEntry',
            validation: 'validationFailed, missingRequiredField, invalidInput',
          }
        },
      },
      create(context) {
        return {
          ThrowStatement(node) {
            const filename = context.getFilename();
            
            // Only check server code
            if (!filename.includes('/actions/') && 
                !filename.includes('/app/api/') &&
                !filename.includes('/lib/')) {
              return;
            }

            if (filename.includes('.test.') || filename.includes('.spec.')) {
              return;
            }

            if (
              node.argument.type === 'NewExpression' &&
              node.argument.callee.name === 'Error'
            ) {
              // Try to suggest appropriate error factory based on message
              let suggestion = 'appropriate error factory';
              if (node.argument.arguments[0] && node.argument.arguments[0].value) {
                const message = node.argument.arguments[0].value.toLowerCase();
                if (message.includes('auth') || message.includes('session') || message.includes('unauthorized')) {
                  suggestion = 'authNoSession or authExpiredSession';
                } else if (message.includes('database') || message.includes('db') || message.includes('query')) {
                  suggestion = 'dbQueryFailed or dbRecordNotFound';
                } else if (message.includes('invalid') || message.includes('required') || message.includes('validation')) {
                  suggestion = 'validationFailed or invalidInput';
                } else if (message.includes('permission') || message.includes('access')) {
                  suggestion = 'authzInsufficientPermissions';
                }
              }

              context.report({
                node,
                messageId: 'useTypedError',
                data: {
                  suggestion,
                },
              });
            }
          },
        };
      },
    },

    /**
     * Rule: require-logger-in-server-actions
     * Ensures all server actions create and use a logger
     */
    'require-logger-in-server-actions': {
      meta: {
        type: 'problem',
        docs: {
          description: 'Require logger creation in server actions',
          category: 'Logging',
        },
        schema: [],
        messages: {
          missingLogger: 'Server actions must create a logger using createLogger() from @/lib/logger',
          missingLoggerImport: 'Must import createLogger from @/lib/logger',
        },
      },
      create(context) {
        let hasCreateLoggerImport = false;
        let hasLoggerCreation = false;
        let isServerAction = false;

        const filename = context.getFilename();
        if (filename.includes('/actions/') || filename.includes('.actions.')) {
          isServerAction = true;
        }

        return {
          ImportDeclaration(node) {
            if (node.source.value === '@/lib/logger') {
              const specifiers = node.specifiers;
              for (const spec of specifiers) {
                if (spec.imported && spec.imported.name === 'createLogger') {
                  hasCreateLoggerImport = true;
                }
              }
            }
          },
          CallExpression(node) {
            if (node.callee.name === 'createLogger') {
              hasLoggerCreation = true;
            }
          },
          'Program:exit'() {
            if (isServerAction && !context.getFilename().includes('.test.')) {
              if (!hasCreateLoggerImport) {
                context.report({
                  node: context.getSourceCode().ast,
                  messageId: 'missingLoggerImport',
                });
              }
              if (hasCreateLoggerImport && !hasLoggerCreation) {
                context.report({
                  node: context.getSourceCode().ast,
                  messageId: 'missingLogger',
                });
              }
            }
          },
        };
      },
    },
  },
};