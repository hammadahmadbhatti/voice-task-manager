# Setup & Deployment Guide

This is the canonical recipe — follow it top to bottom. Every step is dependency-ordered: don't skip ahead.

> **Time budget:**
> - **Local-only**: ~15 minutes once you have API keys
> - **Full AWS production deploy**: ~45 minutes from a fresh AWS account
> - **GitHub Actions CI/CD**: ~10 minutes after AWS is up

---

## Table of contents

1. [Prerequisites — tools to install](#1-prerequisites)
2. [Sign up for provider accounts](#2-provider-accounts)
3. [Clone & install](#3-clone--install)
4. [Local development run](#4-local-development)
5. [AWS account preparation](#5-aws-account-prep)
6. [Deploy infrastructure with Terraform](#6-terraform-apply)
7. [Push provider secrets to SSM](#7-ssm-secrets)
8. [Deploy realtime backend to EC2](#8-deploy-backend)
9. [Deploy frontend to Vercel](#9-deploy-frontend)
10. [Connect Vercel to Cognito (callback URLs)](#10-cognito-callbacks)
11. [Optional: Google OAuth federation](#11-google-oauth)
12. [Optional: GitHub Actions CI/CD setup](#12-github-actions)
13. [Verification checklist](#13-verification)
14. [Troubleshooting](#14-troubleshooting)
15. [Tear-down (avoid bill surprises)](#15-tear-down)

---

## 1. Prerequisites

Install on your local machine:

| Tool | Min version | Install |
|---|---|---|
| **Node.js** | 20 | `nvm install 20 && nvm use 20` or [nodejs.org](https://nodejs.org) |
| **pnpm** | 9 | `corepack enable && corepack prepare pnpm@latest --activate` |
| **Docker Desktop** | latest | [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop) |
| **Terraform** | 1.6+ | `brew install terraform` or [terraform.io/downloads](https://www.terraform.io/downloads) |
| **AWS CLI** | 2.13+ | `brew install awscli` or [aws.amazon.com/cli](https://aws.amazon.com/cli/) |
| **GitHub CLI** | latest | `brew install gh` *(optional but recommended)* |
| **Vercel CLI** | latest | `npm i -g vercel` |
| **jq** | any | `brew install jq` |

Verify:

```bash
node --version    # v20.x
pnpm --version    # 9.x
docker --version  # 20+
terraform --version
aws --version     # aws-cli/2.13+
```

---

## 2. Provider accounts

You need **three** accounts. All have generous free tiers; nothing costs money during the assessment.

### 2.1 Deepgram (STT)

1. Sign up at https://console.deepgram.com
2. **Get $200 free credit** automatically on signup (no card required)
3. Dashboard → **API Keys** → **Create a New API Key**
   - Name: `vtm-dev`
   - Permissions: `Member` (default)
4. **Copy the key now** — Deepgram shows it once.

### 2.2 OpenAI (LLM)

1. Sign up at https://platform.openai.com
2. Add billing — **but set a low usage limit**: Settings → Limits → Set monthly hard cap to **$5**.
3. Settings → **API Keys** → **Create new secret key**
   - Name: `vtm-dev`
   - Project: default
4. Copy the `sk-proj-...` key.

> **Budget reality:** GPT-4o-mini costs ~$0.0006 per conversation turn. $5 buys you ~8,000 turns.

### 2.3 ElevenLabs (TTS)

1. Sign up at https://elevenlabs.io
2. The **Free tier** gives 10,000 characters/month — enough for ~20 minutes of speech. Sufficient for the assessment.
3. Settings → **Profile + API key** → copy your key.
4. (Optional) Browse the [Voice Library](https://elevenlabs.io/app/voice-library) to pick custom voice IDs for `ELEVENLABS_VOICE_ID_EN` and `ELEVENLABS_VOICE_ID_DE`. Defaults in the code are fine.

### 2.4 AWS account

If you don't have one yet:

1. Sign up at https://aws.amazon.com — needs a credit card but the free tier covers our entire footprint for 12 months.
2. After signup, **create an IAM admin user** (don't use root for daily work):
   - IAM → Users → Create user → name `vtm-admin`
   - Attach policy: `AdministratorAccess`
   - Security credentials → Create access key → CLI use case → copy the access key + secret
3. Configure the CLI:
   ```bash
   aws configure
   # AWS Access Key ID:     <from previous step>
   # AWS Secret Access Key: <from previous step>
   # Default region name:   eu-central-1
   # Default output format: json
   ```
4. **Set up a billing alarm immediately:**
   - Switch to `us-east-1` (billing alarms only work there)
   - CloudWatch → Alarms → Create alarm → Browse metrics → Billing → Total Estimated Charge
   - Threshold: `$5` (and another at `$25`, `$50`)
   - Notify your email via SNS

> **Free tier reality check:** This project's AWS footprint costs $0/month for the first 12 months. After that, the EC2 t3.micro becomes ~$8/month and RDS db.t4g.micro becomes ~$13/month. Tear down via `terraform destroy` when you're done.

### 2.5 Vercel (frontend hosting)

1. Sign up at https://vercel.com — login with GitHub for the smoothest path
2. No billing needed; the Hobby plan covers the assessment

---

## 3. Clone & install

```bash
# Clone (replace with your repo URL once pushed)
git clone https://github.com/YOUR-USERNAME/voice-task-manager.git
cd voice-task-manager

# Install everything
pnpm install
```

Expected: `pnpm install` takes 60–90 seconds the first time, ~10 s on subsequent runs. You should see something like `+ 510 packages installed`.

### Set up environment files

```bash
# Root (reference)
cp .env.example .env

# Backend
cp apps/realtime/.env.example apps/realtime/.env

# Frontend
cp apps/web/.env.example apps/web/.env.local
```

Open `apps/realtime/.env` and fill in **three** values:

```bash
OPENAI_API_KEY=sk-proj-...           # from step 2.2
DEEPGRAM_API_KEY=...                  # from step 2.1
ELEVENLABS_API_KEY=...                # from step 2.3
ALLOW_ANONYMOUS=true                  # keep auth out of the way for now
```

Leave the AWS / Cognito ones with their default `REPLACE_ME` placeholders for now — they only matter once you deploy.

---

## 4. Local development run

### 4.1 Start local PostgreSQL

```bash
docker compose up -d
```

Verify:

```bash
docker compose ps
# Should show vtm-postgres (Up, healthy) and vtm-pgweb (Up)
```

Open http://localhost:8081 — pgweb table browser for inspecting your data.

### 4.2 Apply the schema

```bash
pnpm db:local:setup
```

What it does: waits for the Postgres container to be ready, then runs
`drizzle-kit push` which creates the `users` and `tasks` tables (plus
indexes) from `apps/realtime/src/db/schema.ts`. Idempotent — safe to re-run.

> Reset everything (wipe the volume + recreate schema): `pnpm db:local:reset && pnpm db:local:setup`

### 4.3 Run both apps

```bash
pnpm dev
```

This runs `apps/realtime` and `apps/web` in parallel. You should see:

```
@vtm/realtime: 🎙 Realtime server listening port=4000
@vtm/web:      ✓ Ready in 1.3s
@vtm/web:        Local:   http://localhost:3000
```

### 4.4 First conversation

1. Open http://localhost:3000 → it redirects to `/en`
2. Click the orange orb → browser asks for mic permission → **Allow**
3. Say: *"Create a task for syncing with the PM at 10 AM."*
4. Watch the orb turn blue → orange/blue → green, and a task appear on the right.

If anything went wrong, see [Troubleshooting](#14-troubleshooting).

---

You can stop here if you only need a local demo. Sections 5–13 deploy this to AWS + Vercel for a public demo URL.

---

## 5. AWS account prep

### 5.1 Verify region

Everything goes in **Frankfurt (`eu-central-1`)** — GDPR-friendly + low latency for Berlin users.

```bash
aws configure get region
# eu-central-1
```

If wrong: `aws configure set region eu-central-1`.

### 5.2 Verify identity

```bash
aws sts get-caller-identity
# {
#   "UserId": "AIDA...",
#   "Account": "123456789012",
#   "Arn": "arn:aws:iam::123456789012:user/vtm-admin"
# }
```

### 5.3 Bedrock model access (optional but recommended)

If you want the Bedrock Claude Haiku fallback path enabled later:

1. AWS Console → Bedrock → **Model access** (left sidebar) → **Manage model access**
2. Request access to **Anthropic Claude 3 Haiku** in `eu-central-1`
3. Approval is usually instant for Anthropic models

---

## 6. Terraform apply

### 6.1 Configure variables

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
```

Open `terraform.tfvars`. Minimum required edits:

```hcl
aws_region   = "eu-central-1"
environment  = "dev"
project      = "vtm"

# Add your future Vercel URL here once you know it (you can re-apply later).
# For now, localhost is enough to test:
cognito_callback_urls = [
  "http://localhost:3000/en/auth/callback",
  "http://localhost:3000/de/auth/callback"
]
cognito_logout_urls = [
  "http://localhost:3000"
]

# Optional — only if you want SSH access to EC2.
# Skip this and use SSM Session Manager (recommended).
# ec2_key_name      = "my-keypair"
# ssh_allowed_cidrs = ["YOUR.HOME.IP/32"]
```

Leave Google + GitHub variables empty for now; we add them in steps 11 + 12.

### 6.2 Apply

```bash
terraform init     # downloads providers — ~30 s first time
terraform plan     # review the resource list
terraform apply    # type 'yes' to confirm
```

This creates ~25 resources in ~3 minutes:
- Cognito User Pool + Hosted UI domain + SPA client
- RDS PostgreSQL 16 (db.t4g.micro, 20 GB encrypted gp3) + auto-generated DATABASE_URL in SSM
- EC2 t3.micro (Frankfurt) + Elastic IP + Security Group
- S3 bucket for audio archive
- IAM role + policies (least privilege)

### 6.3 Capture outputs

```bash
terraform output
```

Save these — you'll paste them into env files and GitHub variables:

| Output | Where it goes |
|---|---|
| `ec2_public_ip` | Your demo URL (or use it with a custom domain) |
| `cognito_user_pool_id` | `apps/realtime/.env` (server) |
| `cognito_client_id` | `apps/web/.env.local` + Vercel |
| `cognito_domain` | Both |
| `rds_endpoint` | Reference only — the EC2 reads DATABASE_URL straight from SSM |
| `audio_bucket` | Reference only |

A one-liner to format them for `apps/web/.env.local`:

```bash
terraform output -raw frontend_env_template
```

---

## 7. SSM secrets + RDS schema

### 7a. Push provider API keys

The EC2 instance reads provider API keys from SSM Parameter Store at boot — never from a file in the repo. `DATABASE_URL` and `DB_PASSWORD` were already written by Terraform; you only push the SaaS keys:

```bash
cd ..  # back to repo root

export OPENAI_API_KEY=sk-proj-...
export DEEPGRAM_API_KEY=...
export ELEVENLABS_API_KEY=...

infra/scripts/put-secrets.sh
```

Output:

```
→ Writing SSM parameters to /vtm/dev/* in eu-central-1
  ✓ OPENAI_API_KEY
  ✓ DEEPGRAM_API_KEY
  ✓ ELEVENLABS_API_KEY
  ✓ ELEVENLABS_VOICE_ID_EN
  ✓ ELEVENLABS_VOICE_ID_DE
```

### 7b. Reboot EC2 so the userdata picks them up

```bash
INSTANCE_ID=$(terraform -chdir=infra/terraform output -raw ec2_instance_id)
aws ec2 reboot-instances --instance-ids "$INSTANCE_ID"
sleep 90    # wait for the instance to come back up
```

### 7c. Apply Drizzle schema to RDS

RDS is in a private security group — only the EC2 can reach port 5432. We tunnel through it via SSM port-forward and run `drizzle-kit push`:

```bash
infra/scripts/apply-migrations.sh
```

Prereq: install the Session Manager Plugin once:

```bash
# macOS
brew install --cask session-manager-plugin
# Linux: see https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html
```

Expected output:

```
→ Opening SSM port-forward through i-xxx... to ...:5432 (localhost:15432)
  Waiting for tunnel ✓
→ Applying schema via drizzle-kit push
[✓] Changes applied
✓ Schema applied to RDS
```

After this step the `users` and `tasks` tables (plus indexes) exist in RDS.

---

## 8. Deploy backend

The EC2 is now provisioned with Node, Caddy, PM2 — but it has no application code yet. Two options:

### Option A: Push from your laptop (one-off)

```bash
EC2_HOST=$(terraform -chdir=infra/terraform output -raw ec2_public_ip)
EC2_HOST=$EC2_HOST infra/scripts/deploy.sh
```

This requires SSH access (`ec2_key_name` in your tfvars). If you skipped SSH, use Option B.

### Option B: SSM RunCommand (no SSH key needed)

This is what GitHub Actions does too:

```bash
# 1. Build
pnpm install
pnpm --filter @vtm/realtime build

# 2. Package
STAGE=$(mktemp -d)
cp -R apps/realtime/dist "$STAGE/dist"
cp apps/realtime/package.json "$STAGE/"
cp -R apps/realtime/node_modules "$STAGE/node_modules"
cp -R packages/shared "$STAGE/shared"
cp -R node_modules "$STAGE/root_node_modules"
DEPLOY_ID="manual-$(date +%s)"
tar -C "$STAGE" -czf vtm-app.tgz .

# 3. Upload to S3
BUCKET=$(terraform -chdir=infra/terraform output -raw github_actions_artifact_bucket)
aws s3 cp vtm-app.tgz "s3://$BUCKET/deploys/${DEPLOY_ID}.tgz"

# 4. Trigger SSM deploy
INSTANCE_ID=$(terraform -chdir=infra/terraform output -raw ec2_instance_id)
aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --parameters "commands=[\"bash /opt/vtm/remote-deploy.sh s3://$BUCKET/deploys/${DEPLOY_ID}.tgz $DEPLOY_ID\"]" \
  --comment "manual deploy ${DEPLOY_ID}"

# 5. Verify health
curl http://$(terraform -chdir=infra/terraform output -raw ec2_public_ip)/health
# {"status":"ok","uptimeMs":12345,"version":"0.1.0",...}
```

Option A is simpler for first-time bring-up; Option B is what production CI uses (no SSH key surface area).

### 8.1 Verify backend

```bash
EC2_IP=$(terraform -chdir=infra/terraform output -raw ec2_public_ip)
curl http://$EC2_IP/health
# {"status":"ok",...}

# Tail logs via SSM (no SSH needed)
aws ssm start-session --target $(terraform -chdir=infra/terraform output -raw ec2_instance_id)
# (in the session:)
sudo -u vtm pm2 logs vtm --lines 50
```

> If health returns 502 from Caddy, the Node app isn't running. SSM in and run `sudo -u vtm pm2 list` to see status.

---

## 9. Deploy frontend

### 9.1 Link to Vercel

```bash
cd apps/web
vercel link
```

Follow prompts:
- Set up `apps/web`? → **Y**
- Which scope? → your username
- Link to existing project? → **N**
- Project name? → `vtm-web` (or whatever you like)
- Directory? → `./` (current)

This writes `apps/web/.vercel/project.json` (gitignored by default — that's fine).

### 9.2 Configure environment variables

Two ways — UI is simpler, CLI is repeatable:

**Via Vercel UI:**

1. https://vercel.com → your `vtm-web` project → **Settings** → **Environment Variables**
2. Add for all 3 environments (Production / Preview / Development):

| Name | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_WS_URL` | `https://YOUR-EC2-IP-OR-DOMAIN` | The realtime server's URL |
| `NEXT_PUBLIC_API_URL` | (same as above) | REST endpoint |
| `NEXT_PUBLIC_COGNITO_DOMAIN` | `vtm-dev-auth-xxxxxxxx.auth.eu-central-1.amazoncognito.com` | From `terraform output cognito_domain` |
| `NEXT_PUBLIC_COGNITO_CLIENT_ID` | from `terraform output cognito_client_id` | |
| `NEXT_PUBLIC_COGNITO_REDIRECT_URI` | `https://YOUR-VERCEL-URL/en/auth/callback` | We'll know the Vercel URL after first deploy |
| `NEXT_PUBLIC_DEFAULT_LOCALE` | `en` | |
| `NEXT_PUBLIC_ALLOW_ANONYMOUS` | `false` | flip to `true` if you want anon dev login |

**Via Vercel CLI:**

```bash
# (inside apps/web with vercel linked)
vercel env add NEXT_PUBLIC_WS_URL production
# paste the value when prompted; repeat for each var
```

### 9.3 Deploy

```bash
vercel --prod
```

Vercel builds and prints your URL: `https://vtm-web-xxxxxx.vercel.app`.

### 9.4 Update `NEXT_PUBLIC_COGNITO_REDIRECT_URI`

You now know your Vercel URL. Update that one env var, then **redeploy** so the new value is baked into the static bundle:

```bash
vercel env rm NEXT_PUBLIC_COGNITO_REDIRECT_URI production
vercel env add NEXT_PUBLIC_COGNITO_REDIRECT_URI production
# paste: https://vtm-web-xxxxxx.vercel.app/en/auth/callback
vercel --prod
```

---

## 10. Cognito callbacks

Add your Vercel URL to Cognito's allowed callback list:

```bash
cd ../../infra/terraform
```

Edit `terraform.tfvars`:

```hcl
cognito_callback_urls = [
  "http://localhost:3000/en/auth/callback",
  "http://localhost:3000/de/auth/callback",
  "https://vtm-web-xxxxxx.vercel.app/en/auth/callback",
  "https://vtm-web-xxxxxx.vercel.app/de/auth/callback",
]
cognito_logout_urls = [
  "http://localhost:3000",
  "https://vtm-web-xxxxxx.vercel.app",
]
```

```bash
terraform apply
```

Confirms in ~30 s. Now sign-in flows from Vercel will succeed.

---

## 11. Google OAuth (optional)

To enable "Sign in with Google":

### 11.1 Create Google OAuth credentials

1. Go to https://console.cloud.google.com → create or select a project
2. **APIs & Services** → **OAuth consent screen**
   - User Type: **External**
   - App name: `Voice Task Manager`
   - Support email: yours
   - Scopes: `openid`, `email`, `profile`
   - Test users: add yourself
3. **APIs & Services** → **Credentials** → **Create Credentials** → **OAuth client ID**
   - Type: **Web application**
   - Name: `vtm-cognito`
   - Authorized redirect URI: `https://<COGNITO_DOMAIN>/oauth2/idpresponse` *(use the value from `terraform output cognito_domain`, prefixed with `https://`)*
4. Save → copy the **Client ID** and **Client Secret**

### 11.2 Wire into Terraform

Edit `infra/terraform/terraform.tfvars`:

```hcl
google_client_id     = "xxxxx.apps.googleusercontent.com"
google_client_secret = "GOCSPX-..."
```

```bash
terraform apply
```

The "Sign in with Google" button on your Vercel app now works.

---

## 12. GitHub Actions

Skip if you're not using CI/CD. See [`.github/README.md`](./.github/README.md) for the full version.

### 12.1 Push to GitHub

```bash
cd ../..  # repo root
gh repo create voice-task-manager --public --source=. --remote=origin --push
```

Or manually:
```bash
git init
git remote add origin https://github.com/YOUR-USERNAME/voice-task-manager.git
git add -A && git commit -m "Initial commit"
git push -u origin main
```

### 12.2 Tell Terraform about your repo

Edit `infra/terraform/terraform.tfvars`:

```hcl
github_repo     = "YOUR-USERNAME/voice-task-manager"
github_branches = ["main"]
```

```bash
terraform apply
```

This creates the OIDC provider + deploy role in your AWS account.

### 12.3 Copy outputs to GitHub repo variables

```bash
gh variable set AWS_DEPLOY_ROLE_ARN --body "$(terraform -chdir=infra/terraform output -raw github_actions_role_arn)"
gh variable set DEPLOY_BUCKET       --body "$(terraform -chdir=infra/terraform output -raw github_actions_artifact_bucket)"
gh variable set EC2_INSTANCE_ID     --body "$(terraform -chdir=infra/terraform output -raw github_actions_instance_id)"
gh variable set AWS_REGION          --body "eu-central-1"
gh variable set PROJECT             --body "vtm"
```

### 12.4 Branch protection (recommended)

```bash
gh api -X PUT "/repos/$(gh repo view --json nameWithOwner -q .nameWithOwner)/branches/main/protection" \
  -f required_status_checks.strict=true \
  -F required_status_checks.contexts='["Typecheck","Build","Unit tests","Terraform fmt + validate"]' \
  -F enforce_admins=false \
  -F required_pull_request_reviews=null \
  -F restrictions=null
```

Or in the GitHub UI: Settings → Branches → Add rule → require status checks.

### 12.5 Trigger a deploy

```bash
git commit --allow-empty -m "ci: trigger first deploy"
git push origin main
```

Watch the **Actions** tab. First run takes ~4 minutes. After it succeeds:

```bash
curl https://YOUR-EC2-IP/health
# version should reflect the latest commit
```

---

## 13. Verification

After full deploy, run through this checklist:

- [ ] `curl https://<EC2-IP-or-domain>/health` returns 200 with `status: ok`
- [ ] Vercel URL loads without console errors
- [ ] Clicking the orb prompts for mic permission and succeeds
- [ ] First voice command creates a task (`Create a task at 10 AM`)
- [ ] Task appears in RDS: SSM in and run `psql "$DATABASE_URL" -c 'SELECT id, title, scheduled_at FROM tasks LIMIT 5;'`
- [ ] Sign-in with Cognito Hosted UI works (if enabled)
- [ ] Sign-in with Google works (if enabled)
- [ ] German locale toggle switches UI + assistant voice
- [ ] Delete-with-confirmation flow blocks the destructive action without explicit yes
- [ ] Interruption mid-response cuts audio within ~150 ms
- [ ] GitHub Actions deploy on push to main succeeds end-to-end
- [ ] CloudWatch shows logs under `/vtm/deploys` and EC2 instance logs

If all green, your live demo URL is ready to submit.

---

## 14. Troubleshooting

### Local dev

| Symptom | Cause | Fix |
|---|---|---|
| `pnpm dev` fails — "Cannot find @vtm/shared" | Workspace not linked | `pnpm install` from repo root |
| Realtime crashes on startup — "Invalid environment configuration" | Missing API keys in `apps/realtime/.env` | Fill them in; restart |
| Microphone permission denied | Browser blocked | Site settings → Allow microphone |
| No audio playback | Browser autoplay block | Tap the orb once before talking — that counts as a user gesture |
| `Cannot read properties of undefined (reading 'sub')` | Anonymous mode disabled but no token | Set `ALLOW_ANONYMOUS=true` in `apps/realtime/.env` |
| Postgres connection refused | Container not running | `docker compose up -d` then `pnpm db:local:setup` |
| `relation "users" does not exist` | Schema not applied yet | `pnpm db:local:setup` |
| ONNX runtime / VAD load error | Public folder not served | Verify `apps/web/public/worklets/pcm-recorder.js` exists |

### AWS

| Symptom | Cause | Fix |
|---|---|---|
| `terraform apply` hangs at EC2 creation | AMI not available in region | Region must be one Canonical publishes Ubuntu AMIs in — `eu-central-1` always works |
| EC2 `/health` returns 502 from Caddy | Node app not running | `aws ssm start-session --target <id>` → `sudo -u vtm pm2 list` → `pm2 logs vtm` |
| `/health` returns 200 but voice commands fail | API keys missing on EC2 | Re-run `infra/scripts/put-secrets.sh` then reboot the instance |
| Mic works locally, fails on Vercel | Browsers require HTTPS for `getUserMedia` | Configure `domain_name` in tfvars + DNS so Caddy issues TLS |
| WebSocket connection drops repeatedly | Caddy proxy buffering interim STT | Confirm `flush_interval -1` in `/etc/caddy/Caddyfile` (it should be there by default) |
| CSP violation in browser console | Vercel CSP blocking a connect-src | Update `apps/web/vercel.json` → `connect-src` to include the offending host |

### Cognito

| Symptom | Cause | Fix |
|---|---|---|
| Sign-in returns "redirect_uri_mismatch" | Vercel URL not in callbacks | Add to `cognito_callback_urls` in tfvars, `terraform apply` |
| Google sign-in 500s on `/oauth2/idpresponse` | Wrong redirect URI in Google credentials | Must be `https://<cognito-domain>/oauth2/idpresponse` exactly |
| JWT verification fails on server | Pool ID or Client ID env mismatch | `terraform output` and compare with EC2's `/opt/vtm/.env` |

### CI/CD

| Symptom | Cause | Fix |
|---|---|---|
| Deploy workflow fails on OIDC step | Repo variable `AWS_DEPLOY_ROLE_ARN` missing | `gh variable set AWS_DEPLOY_ROLE_ARN --body "..."` |
| SSM RunCommand times out | EC2 SSM agent not running | Instance should reboot to re-register; or check `systemctl status amazon-ssm-agent` |
| Health probe fails post-deploy | App crashed at boot | Check CloudWatch group `/vtm/deploys` for stderr |
| `terraform fmt -check` fails in CI | Local file not formatted | Run `terraform fmt -recursive` locally and commit |

---

## 15. Tear-down

When you're done, remove all AWS resources so you don't burn the free tier:

```bash
cd infra/terraform
terraform destroy
# Type 'yes' to confirm
```

This removes ~25 resources in ~3 minutes. The S3 bucket has `force_destroy = true` in dev mode, so it empties itself before deletion.

Don't forget:

- Vercel project → can leave it (Hobby plan is free)
- Provider accounts → keep them, the keys are useful elsewhere
- OpenAI billing limit → already capped at $5

---

## What "done" looks like

A successful submission package:

1. **Public Vercel URL** that demonstrates everything in `DEMO.md`
2. **GitHub repo URL** with green CI badge
3. **2–5 minute Loom video** following the demo script
4. **README** showing architecture diagram + cost analysis
5. **One-paragraph cover email** with the three links above

Done. Send it.
