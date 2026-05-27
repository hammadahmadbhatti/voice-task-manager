# Voice Task Manager

> Manage your day by talking to it. No buttons. No typing. Just speak.

<!-- After you push to GitHub, replace <owner>/<repo> below to render real status badges. -->
[![CI](https://github.com/OWNER/REPO/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/REPO/actions/workflows/ci.yml)
[![Deploy realtime](https://github.com/OWNER/REPO/actions/workflows/deploy-realtime.yml/badge.svg)](https://github.com/OWNER/REPO/actions/workflows/deploy-realtime.yml)
[![CodeQL](https://github.com/OWNER/REPO/actions/workflows/codeql.yml/badge.svg)](https://github.com/OWNER/REPO/actions/workflows/codeql.yml)

A production-architected voice-first task manager built for the Urban Ground Software Engineer (Student) assessment. Hybrid stack: AWS for infrastructure (Cognito, DynamoDB, EC2, S3) + specialized vendors for voice AI (Deepgram, OpenAI, ElevenLabs).

## Live demo

- **Frontend**: `https://YOUR-VERCEL-URL` (deploy yourself — see [SETUP.md](./SETUP.md))
- **Realtime API**: `https://YOUR-EC2-DOMAIN` (after `terraform apply`)

📖 **[SETUP.md](./SETUP.md)** — canonical step-by-step from clone to live demo (~45 min)
🎬 **[DEMO.md](./DEMO.md)** — 5–7 minute demo script that exercises every assessment requirement
🛠 **[.github/README.md](./.github/README.md)** — GitHub Actions CI/CD setup
🏗 **[infra/terraform/README.md](./infra/terraform/README.md)** — Terraform module reference

## Features

- **Voice-only CRUD**: create, read, update, delete tasks entirely through conversation
- **Real-time streaming pipeline**: Deepgram Nova-2 STT → GPT-4o-mini → ElevenLabs Flash v2.5 TTS, end-to-end ~800–1200 ms latency
- **Barge-in / interruption**: client-side Silero VAD detects speech during TTS playback and aborts the in-flight LLM + audio stream within ~150 ms
- **Context resolution**: handles "the previous one", "the second one", "evening workout", and other natural references via working-memory + LLM tool calls
- **Multi-task in one utterance**: "Create three tasks for tomorrow morning..." → three parallel tool calls
- **Destructive-action confirmation**: deletes require explicit yes-confirmation enforced by a server-side state machine, not just prompting
- **Provider fallback chain**: ElevenLabs → Amazon Polly → browser SpeechSynthesis
- **Bilingual**: English + German (Berlin-relevant)
- **Authentication**: Cognito Hosted UI + Google federation via OAuth2 PKCE (optional in dev — anonymous mode supported)

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (Next.js 14, deployed on Vercel)                        │
│  ┌──────────────┐ ┌─────────────┐ ┌─────────────────────────┐   │
│  │ Mic Capture  │→│ Silero VAD  │→│ AudioWorklet (PCM 16k)  │   │
│  │ getUserMedia │ │ (barge-in)  │ │  → WS frames            │   │
│  └──────────────┘ └─────────────┘ └─────────────────────────┘   │
│        ↑                                       ↓                  │
│  ┌──────────────┐                       ┌──────────────────┐    │
│  │ MSE Audio    │←─ MP3 stream + ───────│ Socket.IO client │    │
│  │ Player       │   barge-in cancel     │                  │    │
│  └──────────────┘                       └──────────────────┘    │
└─────────────────────────────┬───────────────────────────────────┘
                              │ WSS
┌─────────────────────────────▼───────────────────────────────────┐
│  EC2 t3.micro · Frankfurt (eu-central-1) · Caddy + Node.js      │
│                                                                  │
│  Session State (in-memory, swap to Redis for HA)                 │
│        │                                                         │
│  ┌─────▼──────────────┐   ┌──────────────────┐   ┌───────────┐ │
│  │ Deepgram Nova-2    │──▶│ Conversation     │──▶│ ElevenLabs│ │
│  │ Streaming STT      │   │ Orchestrator     │   │  Flash v2.5│ │
│  └────────────────────┘   │ - state machine  │   └─────┬─────┘ │
│                           │ - context resolve│         │       │
│                           │ - confirmation   │         ▼       │
│                           │   guard          │   ┌──────────┐  │
│                           └─────────┬────────┘   │ Polly    │  │
│                                     │ tools      │ (fallback│  │
│                            ┌────────▼─────────┐  └──────────┘  │
│                            │ GPT-4o-mini       │                │
│                            │ (function calling)│                │
│                            └───────────────────┘                │
└──────────────────────────┬──────────────────────────────────────┘
                           │ AWS SDK
┌──────────────────────────▼──────────────────────────────────────┐
│  AWS (Frankfurt, eu-central-1) — GDPR-friendly                  │
│  ┌──────────────┐ ┌────────────────────┐ ┌─────────────────┐   │
│  │ Cognito Pool │ │ RDS PostgreSQL 16  │ │ S3 audio archive│   │
│  │ + Google IdP │ │ db.t4g.micro       │ │ → Glacier @ 30d │   │
│  │ 50k MAU free │ │ users + tasks      │ │ → expire @ 365d │   │
│  │              │ │ 750hr/mo + 20GB free│ │                 │   │
│  └──────────────┘ └────────────────────┘ └─────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

## Tech stack

| Layer | Tech | Why |
|---|---|---|
| Frontend | Next.js 14, React 18, Tailwind, next-intl | Vercel-native, type-safe, good i18n story |
| Voice capture | AudioWorklet + Silero VAD (WASM) | Audio-thread DSP avoids glitches under React rerenders; client-side VAD enables barge-in |
| Transport | Socket.IO over WSS | Automatic reconnect + binary frames first-class |
| Backend | Node.js 20, Express, TypeScript | Fast iteration, mature ecosystem for STT/LLM/TTS SDKs |
| STT | Deepgram Nova-2 streaming | 250 ms first-word latency, $0.26/hr (5× cheaper than AWS Transcribe), $200 signup credit |
| LLM | OpenAI GPT-4o-mini + function calling | Best tool-use at $0.15/$0.60 per 1M tokens, ~400 ms TTFT |
| TTS | ElevenLabs Flash v2.5 (primary) + Polly Neural (fallback) + browser SpeechSynthesis (last resort) | 75 ms TTFB on ElevenLabs Flash; reliability via fallback chain |
| Auth | AWS Cognito Hosted UI + PKCE | 50k MAU free forever, Google federation via Identity Provider config |
| Database | AWS RDS PostgreSQL 16 + Drizzle ORM | Relational schema (users + tasks, FK with ON DELETE CASCADE), 750 hr/month + 20 GB free for 12 mo. Same Cognito user → same row → consistent data across logins |
| Audio archive | AWS S3 with Glacier IR lifecycle | Cheap long-term storage for compliance / analytics |
| Compute | AWS EC2 t3.micro + Caddy + PM2 | 750 hr/month free for 12 months, automatic HTTPS via Caddy |
| IaC | Terraform 1.6 | Reproducible, version-controlled infrastructure |

## Cost analysis

For **1000 sessions of 5 min each**:

| Item | This stack | AWS-only alternative | Notes |
|---|---|---|---|
| STT | Deepgram: **$21.50** | Transcribe: $120 | Deepgram is 5.5× cheaper *and* lower latency |
| LLM | GPT-4o-mini: **$0.60** | Bedrock Haiku: $3 | |
| TTS | ElevenLabs: ~$10 | Polly Neural: free first 12 mo | |
| Compute | EC2 t3.micro: **$0** (free tier) | Same | |
| DB | DynamoDB: **$0** (free tier) | Same | |
| Auth | Cognito: **$0** (free under 50k MAU) | Same | |
| **Total per 1000 sessions** | **~$32** | ~$123 | |

For the assessment (~50 demo sessions): **~$1.50**, easily covered by Deepgram's $200 signup credit. AWS $100 credit goes untouched.

## Project structure

```
voice-task-manager/
├── apps/
│   ├── web/                # Next.js 14 frontend (Vercel)
│   │   ├── src/app/[locale]/         # locale-prefixed routes
│   │   ├── src/components/           # VoiceOrb, Transcript, TaskList, LanguageToggle
│   │   ├── src/hooks/useVoiceSession.ts  # the client-side conductor
│   │   ├── src/lib/audio/            # recorder, vad, player
│   │   ├── src/lib/ws-client.ts      # Socket.IO wrapper
│   │   ├── src/lib/cognito.ts        # OAuth PKCE flow
│   │   ├── public/worklets/pcm-recorder.js   # AudioWorklet (16k PCM)
│   │   └── messages/{en,de}.json     # i18n strings
│   │
│   └── realtime/           # Node.js WS server (EC2)
│       ├── src/server.ts             # Socket.IO + Express
│       ├── src/orchestrator/         # conversation agent + state machine
│       ├── src/agents/task-tools.ts  # tool runtime (CRUD)
│       ├── src/providers/            # Deepgram / OpenAI / ElevenLabs / Polly
│       ├── src/middleware/auth.ts    # Cognito JWT → identity claim
│       ├── src/db/                   # PostgreSQL (Drizzle ORM): schema, client, repos
│       ├── drizzle.config.ts         # drizzle-kit config for migrations
│       └── Dockerfile
│
├── packages/
│   └── shared/             # types + WS protocol + LLM tool schemas + prompts
│       ├── src/types.ts
│       ├── src/protocol.ts           # WebSocket message contract
│       ├── src/schemas/tools.ts      # zod + OpenAI function-call specs
│       └── src/prompts/system.ts     # bilingual system prompts
│
├── infra/
│   ├── terraform/          # Cognito, RDS, EC2, S3, IAM, GitHub OIDC
│   │   ├── cognito.tf
│   │   ├── rds.tf                    # PostgreSQL + auto-generated DATABASE_URL in SSM
│   │   ├── ec2.tf
│   │   ├── s3.tf
│   │   ├── iam.tf
│   │   ├── github-oidc.tf            # OIDC trust for GitHub Actions deploys
│   │   ├── userdata.sh.tftpl         # EC2 bootstrap (Node + Caddy + pm2)
│   │   └── outputs.tf
│   └── scripts/
│       ├── deploy.sh                 # rsync-from-laptop fallback
│       ├── remote-deploy.sh          # runs on EC2 (via SSM in CI)
│       └── put-secrets.sh            # write provider keys to SSM
│
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                    # PR + push: typecheck + build + tf validate
│   │   ├── deploy-realtime.yml       # main → S3 → SSM → pm2 reload
│   │   ├── deploy-web.yml            # optional Vercel CLI deploy
│   │   └── codeql.yml                # weekly security scan
│   ├── dependabot.yml
│   └── README.md                     # CI/CD setup walkthrough
│
├── docker-compose.yml      # local DynamoDB
├── pnpm-workspace.yaml
└── README.md
```

## Local development

### Prereqs

- Node.js 20+
- pnpm 9+ (`corepack enable && corepack prepare pnpm@latest --activate`)
- Docker (for local DynamoDB)

### 1) Get API keys

Sign up for free tiers:

- **Deepgram** — https://console.deepgram.com  ($200 free signup credit)
- **OpenAI** — https://platform.openai.com/api-keys
- **ElevenLabs** — https://elevenlabs.io  (free tier: 10k chars/month)
- **AWS** — only needed for prod deploy; local dev uses dynamodb-local

### 2) Install + env

```bash
pnpm install

cp .env.example .env
cp apps/realtime/.env.example apps/realtime/.env
cp apps/web/.env.example apps/web/.env.local

# Edit apps/realtime/.env — fill in:
#   OPENAI_API_KEY=
#   DEEPGRAM_API_KEY=
#   ELEVENLABS_API_KEY=
#   ALLOW_ANONYMOUS=true  (skip auth in dev)
```

### 3) Start local DynamoDB

```bash
pnpm db:local
pnpm --filter @vtm/realtime exec tsx scripts/create-local-table.ts
```

DynamoDB admin UI: http://localhost:8001

### 4) Run both apps

```bash
pnpm dev
```

- Frontend → http://localhost:3000/en (or /de)
- Realtime API → http://localhost:4000/health

Open `localhost:3000`, click the orb, and start talking.

## Production deploy (~30 minutes)

### 1) Provision AWS

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars — at minimum, leave defaults; optionally add domain_name + ssh_allowed_cidrs

terraform init
terraform plan
terraform apply
```

Outputs include EC2 IP, Cognito IDs, etc.

### 2) Push provider keys to SSM

```bash
export OPENAI_API_KEY=sk-...
export DEEPGRAM_API_KEY=...
export ELEVENLABS_API_KEY=...
infra/scripts/put-secrets.sh

# Reboot EC2 so userdata reloads them into /opt/vtm/.env
aws ec2 reboot-instances --instance-ids "$(cd infra/terraform && terraform output -raw ec2_instance_id)"
```

### 3) Deploy the realtime backend

```bash
infra/scripts/deploy.sh
```

### 4) Deploy the frontend to Vercel

```bash
# Vercel CLI:
cd apps/web
vercel link
# Set NEXT_PUBLIC_* env vars from `terraform output frontend_env_template`
vercel --prod
```

### 5) Add the Vercel URL to Cognito callbacks

Update `cognito_callback_urls` and `cognito_logout_urls` in `terraform.tfvars`, then `terraform apply` again.

### 6) (Optional) Wire up GitHub Actions CI/CD

OIDC-based — no AWS access keys in repo secrets. See [`.github/README.md`](./.github/README.md) for the full setup. TL;DR:

```bash
# Edit terraform.tfvars: set github_repo = "owner/voice-task-manager"
cd infra/terraform && terraform apply

# Copy outputs to repo variables:
gh variable set AWS_DEPLOY_ROLE_ARN --body "$(terraform -chdir=infra/terraform output -raw github_actions_role_arn)"
gh variable set DEPLOY_BUCKET       --body "$(terraform -chdir=infra/terraform output -raw github_actions_artifact_bucket)"
gh variable set EC2_INSTANCE_ID     --body "$(terraform -chdir=infra/terraform output -raw github_actions_instance_id)"
gh variable set AWS_REGION          --body "eu-central-1"
gh variable set PROJECT             --body "vtm"
```

From then on: PRs run typecheck/build/terraform-validate; merges to `main` build a tarball, ship it to S3, and trigger an SSM RunCommand on the EC2 to atomically swap + pm2-reload with automatic rollback if the health probe fails.

### 7) (Optional) Google OAuth

1. Google Cloud Console → APIs & Services → Credentials → Create OAuth client (Web)
2. Authorized redirect URI: `https://<COGNITO_DOMAIN>/oauth2/idpresponse`
3. Put `google_client_id` + `google_client_secret` into `terraform.tfvars`
4. `terraform apply`

## Demo script

Try these in order to exercise every requirement from the brief:

1. **Create**: *"Create a task for syncing with the product manager at 10 AM."* → Assistant confirms.
2. **Create another**: *"Also add a LinkedIn post at 5 PM."*
3. **Update**: *"Change the LinkedIn task to 6 PM."*
4. **Context reference**: *"Actually, move the previous one to 7 PM."*
5. **Read with time filter**: *"What are today's evening tasks?"* → Assistant summarizes naturally, not as a bulleted list.
6. **Ordinal reference**: *"Move the second one to tomorrow."*
7. **Semantic match**: *"Move my evening workout to 8 PM."* (after creating a workout task)
8. **Multi-task**: *"Create three tasks for tomorrow morning. Gym at 7 AM, team sync at 9 AM, post on LinkedIn at 11 AM."*
9. **Delete with confirmation**: *"Delete the 9:15 task."* → Assistant: "I couldn't find a 9:15 task — did you mean the 9 AM team sync?" → *"Yes."* → Assistant: "Are you sure you want to delete the team sync? Yes or no?" → *"Yes."*
10. **Barge-in**: While the assistant is reading a long list, interrupt with *"No, delete the LinkedIn one."* → Audio cuts immediately, new request flows through.

## Failure handling

| Failure | Recovery |
|---|---|
| Low STT confidence | Skip LLM, ask user to repeat |
| LLM timeout (12 s) | Apologize, ask to retry |
| ElevenLabs error | Fall back to Polly, then to browser SpeechSynthesis |
| Deepgram disconnect | Auto-reconnect via SDK; user is asked to repeat |
| WebSocket drop | Socket.IO reconnects with exponential backoff; client re-issues `hello` |
| Ambiguous delete reference | `request_clarification` tool surfaces candidates |
| Destructive action without yes | Server-side state machine blocks it, regardless of LLM behavior |

## Security notes

- **JWT verification**: ID tokens validated against Cognito's JWKS with key caching (aws-jwt-verify)
- **Row isolation**: every DynamoDB key starts with `USER#<userId>` — physically impossible to query another user's data without code injection
- **IAM least privilege**: EC2 role has DynamoDB R/W on one table only, Polly synthesize, S3 R/W on one bucket only, SSM read on `/vtm/*` only
- **IMDSv2 required**: EC2 metadata service requires session tokens, blocking SSRF-based credential theft
- **EU data residency**: all AWS resources in `eu-central-1` (Frankfurt) — GDPR-friendly for Urban Ground's EU users
- **No secrets in env files in git**: provider keys are in SSM Parameter Store; EC2 reads them at boot
- **CSP / CORS**: server allows only configured origins

## What I'd change for production at Urban Ground scale

This is a polished prototype, not a 100k-user system. Things I deliberately deferred but would address next:

1. **Stateless realtime servers + Redis-backed sessions** — current design pins a user to one Node process. Move session state to ElastiCache Redis or DynamoDB to support horizontal scaling + zero-downtime deploys.
2. **WebRTC instead of WebSocket for audio** — lower latency, better packet loss handling, native echo cancellation. WebSocket is fine for prototypes but degrades on flaky networks.
3. **Speculative TTS** — start streaming TTS for the first sentence while the LLM is still generating, cutting another 200–400 ms of perceived latency.
4. **OpenAI Realtime API migration path** — replace the cascaded pipeline with `gpt-4o-realtime-preview` for sub-500 ms end-to-end. Tradeoff: 5–10× cost, more vendor lock-in. Keep the cascaded path as fallback.
5. **GDPR / PII redaction** — strip PII from conversation logs before they hit CloudWatch; offer per-user data export + delete endpoints.
6. **Rate limiting** — per-user concurrent session cap, per-IP token bucket on the WS handshake.
7. **Multi-region failover** — Route 53 weighted routing + active-passive EC2 in `eu-west-1` for DR.
8. **Observability** — OpenTelemetry traces stitching browser → WS → Deepgram → LLM → TTS, with the STT-to-TTS span as the primary SLO. Export to Grafana Cloud (free tier).
9. **Conversation analytics** — record (with consent) which intents have the lowest confirmation rate, which prompts cause the most clarification requests — directly drives prompt-engineering iterations.

## License

MIT — see LICENSE.
