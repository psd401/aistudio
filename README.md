# AI Studio

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Built with Next.js](https://img.shields.io/badge/Built%20with-Next.js%2015-black)](https://nextjs.org/)
[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](https://github.com/psd401/aistudio/releases)

> **Bring frontier AI to K-12 education—securely, affordably, and responsibly.**

AI Studio is an open-source platform that provides K-12 educators and students with access to cutting-edge generative AI models at **90% lower cost** than individual licenses. Built with privacy-first architecture and deployed within district infrastructure, it democratizes access to AI tools that were previously cost-prohibitive for schools.

## 🎬 See It In Action

**Learn more**: [https://psd401.ai/aistudio](https://psd401.ai/aistudio)

AI Studio is a **self-hosted platform** deployed within your district infrastructure for security and compliance. Screenshots and feature overview available on our project page.

**Ready to deploy?** See the complete [Deployment Guide](./docs/DEPLOYMENT.md)

## 🎯 Why AI Studio?

### The Problem
- **Cost Barriers**: Individual AI subscriptions cost $20-200/month per user—unsustainable for districts
- **Access Inequality**: Students lack exposure to frontier models used in higher education and industry
- **Data Privacy**: Third-party AI services raise concerns about student data protection
- **Content Safety**: Consumer AI tools lack appropriate safeguards for K-12 environments
- **Complexity**: Creating custom AI assistants requires coding expertise

### The Solution
AI Studio eliminates these barriers by:
- **90% Cost Reduction**: Secure API architecture replaces expensive per-seat licenses
- **Multi-Model Access**: Real-time switching between GPT-5, Claude Opus, and Google Gemini
- **District-Level Security**: All data processed within your secure servers—nothing leaves your environment
- **K-12 Content Safety**: Automatic content filtering and PII protection across all AI interactions
- **No-Code Customization**: Design custom AI assistants using visual prompt chains
- **Open Source**: MIT-licensed, fully self-hostable on your infrastructure

## ✨ Key Features

### For Educators & Students

- 🤖 **Nexus Chat** - Conversational AI with multiple frontier models
  - Real-time streaming responses
  - Conversation history and organization
  - Model comparison side-by-side

- 🏗️ **Assistant Architect** - No-code custom AI assistant builder
  - Visual prompt chain designer
  - Variable substitution between prompts
  - Knowledge repository integration
  - Scheduled execution

- 📚 **Knowledge Repositories** - Upload and search documents
  - PDF, DOCX, TXT support with OCR
  - Vector embeddings for semantic search
  - Context-aware AI responses

- 📊 **Model Compare** - Side-by-side model evaluation
  - Compare GPT-5, Claude Opus, Gemini responses
  - Token usage and cost analysis
  - Performance metrics

### For Administrators

- 🔒 **Enterprise Security**
  - AWS Cognito authentication with Google SSO
  - Role-based access control (RBAC)
  - Tool-level permissions
  - Audit logging

- 🛡️ **K-12 Content Safety** - Purpose-built for educational environments
  - **Content Filtering**: Blocks inappropriate content (violence, hate speech, sexual content) in both inputs and AI responses using Amazon Bedrock Guardrails
  - **PII Protection**: Automatically detects and tokenizes student personal information (names, emails, phone numbers) before sending to AI providers
  - **Compliance Ready**: Helps meet COPPA, FERPA, and CIPA requirements
  - **Real-time Alerts**: SNS notifications for safety violations
  - **Zero Configuration**: Works automatically across all AI providers
  - See [K-12 Content Safety Documentation](./docs/features/k12-content-safety.md) for details

- 💰 **Cost Control**
  - Transparent usage tracking
  - Per-user quotas and rate limiting
  - Provider cost comparison
  - Auto-pause dev environments

- 📈 **Monitoring & Observability**
  - CloudWatch dashboards
  - OpenTelemetry tracing
  - Circuit breaker for AI provider failures
  - Performance metrics

## 🏗️ Architecture

Built on AWS with production-ready infrastructure:

- **Frontend**: Next.js 15 (App Router) with React Server Components
- **Backend**: ECS Fargate containers with Application Load Balancer
- **Database**: Aurora Serverless v2 (PostgreSQL 15) with pgvector for embeddings
- **Authentication**: AWS Cognito + NextAuth v5
- **AI Providers**: OpenAI (GPT-5), Anthropic (Claude), Google (Gemini), AWS Bedrock
- **Infrastructure**: AWS CDK (TypeScript) following Well-Architected Framework
- **Streaming**: Server-Sent Events (SSE) over HTTP/2 for real-time responses

See [Architecture Diagrams](./docs/diagrams/README.md) for detailed visualizations.

## 🚀 Quick Start

### Prerequisites

- Node.js 20.x and npm
- AWS CLI configured with appropriate credentials
- AWS CDK CLI (`npm install -g aws-cdk`)
- Docker installed (for building container images)

### Local Development

```bash
# Clone repository
git clone https://github.com/psd401/aistudio.git
cd aistudio

# Install dependencies
npm install

# Copy environment variables
cp .env.example .env.local
# Edit .env.local with your AWS RDS cluster ARN and secret ARN

# Run development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to see the application.

### Deployment to AWS

```bash
# Bootstrap CDK (one-time)
cd infra
npx cdk bootstrap aws://ACCOUNT-ID/REGION

# Deploy infrastructure stacks
npx cdk deploy AIStudio-DatabaseStack-Dev
npx cdk deploy AIStudio-AuthStack-Dev
npx cdk deploy AIStudio-StorageStack-Dev
npx cdk deploy AIStudio-DocumentProcessingStack-Dev
npx cdk deploy AIStudio-FrontendStack-Dev

# Or deploy all at once
npx cdk deploy --all
```

See [Deployment Guide](./docs/DEPLOYMENT.md) for detailed instructions.

## 📊 Cost Comparison

### Traditional Approach (Per-Seat Licenses)
```
100 users × $20/month (ChatGPT Plus) = $2,000/month = $24,000/year
```

### AI Studio (API-Based)
```
100 users × average 50,000 tokens/day
= 1.5M tokens/day × 30 days = 45M tokens/month
= $450/month (GPT-5) + $200 infrastructure = $650/month = $7,800/year

Savings: $16,200/year (67% reduction)
```

With mixed usage (Gemini + GPT-4 mini), costs drop to ~$200/month (**90% savings**).

## 🛠️ Tech Stack

### Frontend
- Next.js 15 with App Router
- React 19 with Server Components
- Shadcn UI component library
- Tailwind CSS for styling
- Vercel AI SDK v5 for streaming

### Backend
- ECS Fargate for container hosting
- Aurora Serverless v2 (PostgreSQL)
- RDS Data API (no connection pooling needed)
- AWS Lambda for async processing
- S3 for document storage
- AWS Textract for OCR

### Infrastructure
- AWS CDK for Infrastructure as Code
- VPC with multi-AZ subnets
- Application Load Balancer with HTTP/2
- CloudWatch + ADOT for observability
- Secrets Manager for credentials
- Cognito for authentication

## 📚 Documentation

### Core Documentation
- [Architecture Overview](./docs/ARCHITECTURE.md) - Complete system architecture
- [Deployment Guide](./docs/DEPLOYMENT.md) - Step-by-step deployment
- [API Reference](./docs/API_REFERENCE.md) - REST endpoints and server actions
- [Error Reference](./docs/ERROR_REFERENCE.md) - Error codes and debugging
- [Troubleshooting](./docs/TROUBLESHOOTING.md) - Common issues and solutions

### Infrastructure
- [CDK Infrastructure](./infra/README.md) - AWS CDK stack details
- [VPC Network Topology](./docs/diagrams/02-vpc-network-topology.md)
- [AWS Service Architecture](./docs/diagrams/03-aws-service-architecture.md)

### Visual Architecture
- [All Diagrams (9 total)](./docs/diagrams/README.md) - 10,000+ lines of visual documentation
- [Database ERD](./docs/diagrams/04-database-erd.md) - 54 PostgreSQL tables
- [Authentication Flow](./docs/diagrams/05-authentication-flow.md) - OAuth 2.0 flow
- [Streaming Architecture](./docs/diagrams/09-streaming-architecture.md) - SSE implementation

### Development
- [Developer Guide](./DEVELOPER_GUIDE.md) - Development setup and workflow
- [Library Documentation](./lib/README.md) - Core utilities and patterns
- [CLAUDE.md](./CLAUDE.md) - AI assistant development guidelines

## 🧪 Testing

```bash
# Run test suite
npm test

# Run tests in watch mode
npm run test:watch

# Run linting
npm run lint

# Run type checking
npm run typecheck
```

## 🤝 Contributing

We welcome contributions! Please see [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## 📄 License

MIT License - see [LICENSE](./LICENSE) file for details.

## 🙏 Acknowledgments

AI Studio was developed by Peninsula School District (PSD401) to bring world-class AI tools to K-12 education. Built with:

- [Next.js](https://nextjs.org/) - React framework
- [Vercel AI SDK](https://sdk.vercel.ai/) - AI streaming infrastructure
- [AWS CDK](https://aws.amazon.com/cdk/) - Infrastructure as Code
- [Shadcn UI](https://ui.shadcn.com/) - UI component library

## 🔗 Links

- **Website**: [psd401.ai/aistudio](https://psd401.ai/aistudio)
- **Documentation**: [docs/](./docs/)
- **Issues**: [GitHub Issues](https://github.com/psd401/aistudio/issues)
- **Discussions**: [GitHub Discussions](https://github.com/psd401/aistudio/discussions)

---

**Built with ❤️ for K-12 education**

*Making frontier AI accessible, secure, and affordable for every student.*
