# Authentication & Authorization Flow

Complete authentication flow using AWS Cognito, Google OAuth, and NextAuth v5 with role-based access control.

## High-Level Authentication Architecture

```mermaid
sequenceDiagram
    participant User
    participant Browser
    participant NextJS as Next.js (ECS)
    participant NextAuth as NextAuth v5
    participant Cognito as AWS Cognito
    participant Google as Google OAuth
    participant Aurora as Aurora DB

    User->>Browser: Click "Sign In with Google"
    Browser->>NextJS: GET /auth/signin
    NextJS->>NextAuth: initiate OAuth flow
    NextAuth->>Cognito: Request OAuth authorization
    Cognito->>Browser: Redirect to Cognito Hosted UI
    Browser->>Google: Redirect to Google OAuth consent
    Google->>User: Show permission screen
    User->>Google: Grant permissions
    Google->>Cognito: Return authorization code
    Cognito->>Browser: Redirect with auth code
    Browser->>NextJS: GET /api/auth/callback with code
    NextJS->>Cognito: Exchange code for tokens
    Cognito->>NextJS: Return ID token + Access token
    NextJS->>Aurora: Check/create user from cognito_sub
    Aurora->>NextJS: Return user record
    NextJS->>Aurora: Fetch user roles and tools
    Aurora->>NextJS: Return roles + tools
    NextJS->>NextAuth: Create session with JWT
    NextAuth->>Browser: Set HTTP-only session cookie
    Browser->>User: Redirect to dashboard
```

## Detailed OAuth 2.0 Flow

```mermaid
graph TB
    START[User clicks Sign In] --> INIT[NextAuth initiates OAuth]
    INIT --> COGNITO_AUTH{Cognito Authorization Endpoint}

    COGNITO_AUTH --> HOSTED_UI[Cognito Hosted UI]
    HOSTED_UI --> GOOGLE_SELECT[User selects Google]
    GOOGLE_SELECT --> GOOGLE_CONSENT[Google Consent Screen]

    GOOGLE_CONSENT --> |User approves| GOOGLE_CB[Google callback to Cognito]
    GOOGLE_CONSENT --> |User denies| ERROR_DENIED[Access Denied Error]

    GOOGLE_CB --> COGNITO_TOKEN[Cognito Token Endpoint]
    COGNITO_TOKEN --> VALIDATE[Validate Google ID Token]

    VALIDATE --> |Valid| COGNITO_LINK{User linked to Cognito?}
    VALIDATE --> |Invalid| ERROR_TOKEN[Token Validation Error]

    COGNITO_LINK --> |No| CREATE_COGNITO[Create Cognito user]
    COGNITO_LINK --> |Yes| EXISTING_COGNITO[Use existing Cognito user]

    CREATE_COGNITO --> ISSUE_TOKENS[Issue Cognito tokens]
    EXISTING_COGNITO --> ISSUE_TOKENS

    ISSUE_TOKENS --> APP_CB[Redirect to app callback]
    APP_CB --> EXCHANGE[Exchange auth code for tokens]
    EXCHANGE --> DB_UPSERT[Upsert user in Aurora]
    DB_UPSERT --> LOAD_ROLES[Load user roles + tools]
    LOAD_ROLES --> CREATE_SESSION[Create NextAuth session]
    CREATE_SESSION --> SET_COOKIE[Set HTTP-only cookie]
    SET_COOKIE --> COMPLETE[Redirect to dashboard]

    ERROR_DENIED --> ERROR_PAGE[Error page with retry]
    ERROR_TOKEN --> ERROR_PAGE

    classDef cognito fill:#ff9800,stroke:#e65100,stroke-width:2px
    classDef google fill:#4285f4,stroke:#1a73e8,stroke-width:2px
    classDef app fill:#4caf50,stroke:#388e3c,stroke-width:2px
    classDef error fill:#f44336,stroke:#c62828,stroke-width:2px

    class COGNITO_AUTH,HOSTED_UI,COGNITO_TOKEN,COGNITO_LINK,CREATE_COGNITO,EXISTING_COGNITO,ISSUE_TOKENS cognito
    class GOOGLE_SELECT,GOOGLE_CONSENT,GOOGLE_CB google
    class APP_CB,EXCHANGE,DB_UPSERT,LOAD_ROLES,CREATE_SESSION,SET_COOKIE,COMPLETE app
    class ERROR_DENIED,ERROR_TOKEN,ERROR_PAGE error
```

## Session Management

```mermaid
sequenceDiagram
    participant Client
    participant NextJS as Next.js Server
    participant NextAuth as NextAuth v5
    participant Aurora as Aurora DB

    Client->>NextJS: HTTP Request with session cookie
    NextJS->>NextAuth: Verify JWT token

    alt Token Valid & Not Expired
        NextAuth->>NextAuth: Decrypt JWT payload
        NextAuth->>NextJS: Return session data
        NextJS->>Client: Process request normally
    else Token Expired
        NextAuth->>NextAuth: Check refresh window
        alt Within refresh window
            NextAuth->>Aurora: Verify user still exists
            Aurora->>NextAuth: User valid
            NextAuth->>NextAuth: Issue new JWT
            NextAuth->>Client: Set new session cookie
            NextJS->>Client: Process request
        else Outside refresh window
            NextAuth->>Client: Clear session cookie
            NextAuth->>Client: Redirect to /auth/signin
        end
    else Token Invalid or Missing
        NextAuth->>Client: Redirect to /auth/signin
    end
```

## Role-Based Access Control (RBAC)

```mermaid
graph LR
    USER[User] --> SESSION[Session Data]
    SESSION --> |contains| USER_ID[User ID]
    SESSION --> |contains| ROLES[Role IDs]

    subgraph "Authorization Check"
        REQ[Incoming Request] --> PROTECTED{Protected Route?}
        PROTECTED --> |Yes| CHECK_SESSION{Has Session?}
        PROTECTED --> |No| ALLOW[Allow Access]

        CHECK_SESSION --> |No| REDIRECT_LOGIN[Redirect to Login]
        CHECK_SESSION --> |Yes| CHECK_ROLE{Has Required Role?}

        CHECK_ROLE --> |No| FORBIDDEN[403 Forbidden]
        CHECK_ROLE --> |Yes| CHECK_TOOL{Has Tool Permission?}

        CHECK_TOOL --> |No| FORBIDDEN
        CHECK_TOOL --> |Yes| ALLOW
    end

    ALLOW --> HANDLER[Execute Request Handler]

    classDef access fill:#4caf50,stroke:#388e3c,stroke-width:2px
    classDef deny fill:#f44336,stroke:#c62828,stroke-width:2px
    classDef check fill:#2196f3,stroke:#1976d2,stroke-width:2px

    class ALLOW,HANDLER access
    class REDIRECT_LOGIN,FORBIDDEN deny
    class PROTECTED,CHECK_SESSION,CHECK_ROLE,CHECK_TOOL check
```

## Tool Permission Matrix

```mermaid
graph TB
    subgraph "Administrator Role"
        ADMIN[Administrator] --> |has access to| ALL_TOOLS[All Tools]
        ALL_TOOLS --> CHAT[Nexus Chat]
        ALL_TOOLS --> COMPARE[Model Compare]
        ALL_TOOLS --> ARCHITECT[Assistant Architect]
        ALL_TOOLS --> REPOS[Knowledge Repositories]
        ALL_TOOLS --> ADMIN_PANEL[Admin Panel]
        ALL_TOOLS --> IDEAS[Ideas Board]
    end

    subgraph "Staff Role"
        STAFF[Staff] --> |has access to| STAFF_TOOLS[Limited Tools]
        STAFF_TOOLS --> CHAT2[Nexus Chat]
        STAFF_TOOLS --> COMPARE2[Model Compare]
        STAFF_TOOLS --> ARCHITECT2[Assistant Architect]
        STAFF_TOOLS --> IDEAS2[Ideas Board]
        STAFF_TOOLS -.blocked.-> ADMIN_PANEL2[Admin Panel]
        STAFF_TOOLS -.blocked.-> REPOS2[Knowledge Repositories]
    end

    subgraph "User Role (Default)"
        DEFAULT[User] --> |has access to| USER_TOOLS[Basic Tools]
        USER_TOOLS --> CHAT3[Nexus Chat]
        USER_TOOLS --> IDEAS3[Ideas Board]
        USER_TOOLS -.blocked.-> COMPARE3[Model Compare]
        USER_TOOLS -.blocked.-> ARCHITECT3[Assistant Architect]
        USER_TOOLS -.blocked.-> ADMIN_PANEL3[Admin Panel]
        USER_TOOLS -.blocked.-> REPOS3[Knowledge Repositories]
    end

    classDef admin fill:#f44336,stroke:#c62828,stroke-width:2px
    classDef staff fill:#ff9800,stroke:#e65100,stroke-width:2px
    classDef user fill:#4caf50,stroke:#388e3c,stroke-width:2px
    classDef blocked fill:#9e9e9e,stroke:#616161,stroke-width:1px,stroke-dasharray: 5 5

    class ADMIN,ALL_TOOLS admin
    class STAFF,STAFF_TOOLS staff
    class DEFAULT,USER_TOOLS user
    class ADMIN_PANEL2,REPOS2,COMPARE3,ARCHITECT3,ADMIN_PANEL3,REPOS3 blocked
```

## Server Action Authorization

```typescript
// Example: /actions/assistant-architect.actions.ts
export async function executeAssistantArchitectAction(params) {
  const requestId = generateRequestId()
  const log = createLogger({ requestId, action: "executeAssistantArchitect" })

  try {
    // 1. Get session (includes user + roles)
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized - no session")
      throw ErrorFactories.authNoSession()
    }

    // 2. Check tool permission
    const hasAccess = await hasToolAccess("assistant-architect")
    if (!hasAccess) {
      log.warn("Forbidden - no tool access", {
        userId: session.user.id
      })
      throw ErrorFactories.authInsufficientPermissions()
    }

    // 3. Execute business logic
    const result = await processExecution(params)
    return createSuccess(result)

  } catch (error) {
    return handleError(error, "Execution failed", { requestId })
  }
}
```

## JWT Token Structure

```json
{
  "header": {
    "alg": "HS256",
    "typ": "JWT"
  },
  "payload": {
    "sub": "cognito-sub-uuid",
    "userId": 123,
    "email": "user@example.com",
    "name": "John Doe",
    "roles": [
      {
        "id": 1,
        "name": "administrator"
      }
    ],
    "tools": [
      "nexus-chat",
      "assistant-architect",
      "model-compare",
      "knowledge-repositories",
      "admin-panel"
    ],
    "iat": 1704067200,
    "exp": 1704153600,
    "jti": "session-uuid"
  },
  "signature": "HMACSHA256(...)"
}
```

## Session Cookie Configuration

```typescript
// /lib/auth/config.ts
export const authConfig = {
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60, // 30 days
    updateAge: 24 * 60 * 60,   // Update session every 24 hours
  },
  cookies: {
    sessionToken: {
      name: "__Secure-next-auth.session-token",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: true, // HTTPS only in production
      },
    },
  },
  pages: {
    signIn: "/auth/signin",
    error: "/auth/error",
  },
}
```

## First-Time User Flow

```mermaid
sequenceDiagram
    participant User
    participant NextJS as Next.js
    participant Cognito
    participant Aurora as Aurora DB

    User->>NextJS: First sign-in (no user record)
    NextJS->>Cognito: Validate ID token
    Cognito->>NextJS: Valid token with cognito_sub
    NextJS->>Aurora: SELECT WHERE cognito_sub = ?
    Aurora->>NextJS: No user found
    NextJS->>Aurora: INSERT INTO users (cognito_sub, email, ...)
    Aurora->>NextJS: User created (id: 123)
    NextJS->>Aurora: INSERT INTO user_roles (user_id: 123, role_id: 3) -- "User" role
    Aurora->>NextJS: Role assigned
    NextJS->>Aurora: SELECT role_tools WHERE role_id = 3
    Aurora->>NextJS: Return default tool permissions
    NextJS->>User: Create session with basic permissions
    User->>NextJS: Can access: Nexus Chat, Ideas Board
    User->>NextJS: Cannot access: Admin Panel, Model Compare
```

## Admin Role Grant (Manual Process)

After deploying the application, the first administrator must be granted manually:

```sql
-- 1. Find user ID by email
SELECT id, email, cognito_sub FROM users WHERE email = 'admin@example.com';

-- 2. Check/create administrator role
SELECT id FROM roles WHERE name = 'administrator';
-- If not exists:
INSERT INTO roles (name, description, is_system)
VALUES ('administrator', 'Administrator role with full access', true);

-- 3. Assign administrator role to user
INSERT INTO user_roles (user_id, role_id)
SELECT
    u.id,
    r.id
FROM users u, roles r
WHERE u.email = 'admin@example.com'
  AND r.name = 'administrator';

-- 4. Verify tool access (auto-granted via role_tools)
SELECT t.identifier, t.name
FROM tools t
JOIN role_tools rt ON t.id = rt.tool_id
JOIN roles r ON rt.role_id = r.id
WHERE r.name = 'administrator';
```

## Security Best Practices

### Implemented
- ✅ HTTP-only cookies (prevent XSS token theft)
- ✅ Secure flag in production (HTTPS only)
- ✅ SameSite=lax (CSRF protection)
- ✅ JWT expiration (30-day max)
- ✅ Server-side session validation
- ✅ Role-based tool permissions
- ✅ Database-driven authorization (not client-side)
- ✅ Cognito user pool encryption
- ✅ Google OAuth scope limitation

### Monitoring
- Failed login attempts logged to CloudWatch
- Session creation/expiry events tracked
- Permission denial audited with user context
- Cognito events forwarded to CloudWatch

### Rate Limiting (Future Enhancement)
- Login attempts: 5 per minute per IP
- Session refresh: 10 per hour per user
- Tool access checks: Cached for 5 minutes

---

**Last Updated**: November 2025
**Auth Provider**: AWS Cognito + NextAuth v5
**OAuth Providers**: Google (primary)
**Session Strategy**: JWT with HTTP-only cookies
**Session Duration**: 30 days with 24-hour refresh
