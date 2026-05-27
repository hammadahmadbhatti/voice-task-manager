# GitHub Actions CI/CD

Three workflows, plus Dependabot.

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | Every PR + push to `main` | Typecheck, build, test, terraform fmt + validate |
| `deploy-realtime.yml` | Push to `main` touching `apps/realtime/**` (or manual) | Build artifact → S3 → SSM RunCommand on EC2 → pm2 reload → health probe (rollback on failure) |
| `deploy-web.yml` | Push to `main` touching `apps/web/**` (or manual) | Optional fallback — use Vercel's GitHub App instead unless you need CLI control |
| `codeql.yml` | PR + weekly cron | Static analysis for security issues |

Concurrency is configured so:
- PR CI cancels in-flight runs on new pushes (saves minutes)
- Deploys do **not** cancel — partial deploys are dangerous

## One-time setup

Everything is OIDC-based — **no long-lived AWS keys live in GitHub**. The deploy role is created by Terraform.

### 1. Tell Terraform about your repo

Edit `infra/terraform/terraform.tfvars`:

```hcl
github_repo     = "your-username/voice-task-manager"
github_branches = ["main"]
```

```bash
cd infra/terraform
terraform apply
```

### 2. Copy outputs to GitHub repo variables

Terraform output → GitHub Settings → Secrets and variables → Actions → **Variables** tab (these are non-secret IDs, not credentials):

| Terraform output | GitHub variable name |
|---|---|
| `github_actions_role_arn` | `AWS_DEPLOY_ROLE_ARN` |
| `github_actions_artifact_bucket` | `DEPLOY_BUCKET` |
| `github_actions_instance_id` | `EC2_INSTANCE_ID` |
| (manually set) `AWS_REGION` | `eu-central-1` |
| (manually set) `PROJECT` | `vtm` |
| (manually set, optional) `PUBLIC_HEALTH_URL` | `https://your-domain.com/health` |

Get them in one go:

```bash
cd infra/terraform
terraform output -json | jq '{
  AWS_DEPLOY_ROLE_ARN: .github_actions_role_arn.value,
  DEPLOY_BUCKET:       .github_actions_artifact_bucket.value,
  EC2_INSTANCE_ID:     .github_actions_instance_id.value
}'
```

Or via the GitHub CLI:

```bash
gh variable set AWS_DEPLOY_ROLE_ARN   --body "$(terraform -chdir=infra/terraform output -raw github_actions_role_arn)"
gh variable set DEPLOY_BUCKET         --body "$(terraform -chdir=infra/terraform output -raw github_actions_artifact_bucket)"
gh variable set EC2_INSTANCE_ID       --body "$(terraform -chdir=infra/terraform output -raw github_actions_instance_id)"
gh variable set AWS_REGION            --body "eu-central-1"
gh variable set PROJECT               --body "vtm"
```

### 3. Create the `production` environment (optional but recommended)

GitHub UI → Settings → Environments → **New environment** → name it `production`.

This:
- Enables required reviewers before a deploy fires
- Adds a deploy log accessible from the repo home page
- Is referenced by `deploy-realtime.yml` via `environment: production`

If you skip this, the workflow still works — the `environment:` line is harmless when no env exists.

### 4. Branch protection on `main`

Settings → Branches → Add rule for `main`:

- ✅ Require status checks: `Typecheck`, `Build`, `Terraform fmt + validate`
- ✅ Require pull request reviews (optional for solo project)
- ✅ Require linear history

This stops broken code from triggering a deploy.

## How the deploy actually works

```
git push origin main
   │
   ▼
GitHub Actions ── OIDC ──▶ AWS STS ──▶ assume vtm-dev-github-deploy role (15-min creds)
   │
   ├─ pnpm install + build apps/realtime
   ├─ tar dist + node_modules + shared
   └─ aws s3 cp vtm-<sha>.tgz s3://<bucket>/deploys/
   │
   ▼
aws ssm send-command  ── targets EC2 by ID
   │
   ▼  (runs on the EC2 as root via SSM agent)
   ├─ aws s3 cp the artifact
   ├─ unpack to /opt/vtm/app.new
   ├─ atomic mv → /opt/vtm/app
   ├─ pm2 reload vtm
   └─ curl http://127.0.0.1:4000/health  (10× with 1 s sleep)
       │
       ├─ healthy → keep /opt/vtm/app, clean up
       └─ unhealthy → mv /opt/vtm/app.old back, reload, exit 1
   │
   ▼
Workflow tails StandardOutput from SSM, sets exit code accordingly,
optionally smoke-tests the public health URL from the GitHub runner.
```

Why this design over alternatives:

| Alternative | Why I didn't use it |
|---|---|
| SSH from runner with key in secrets | Long-lived secret, rotating it is annoying, key compromise = full server compromise |
| CodeDeploy | More moving parts, agent on instance, separate IAM model — overkill for one instance |
| Docker push to ECR + pull on EC2 | Adds ECR cost + image-build time; we don't actually need container isolation here |
| Lambda + API Gateway WS | Lambda cold starts hurt voice latency — see the main README architecture notes |

OIDC + S3 + SSM keeps the surface area minimal and uses only services the project already needs.

## Vercel frontend

**Preferred:** Connect the repo via the [Vercel GitHub App](https://vercel.com/docs/deployments/git/vercel-for-github). It auto-creates preview deploys on PRs and production on main pushes. No workflow needed.

**Fallback:** If you need pipeline gating (e.g. "only deploy if CI passes"), enable `deploy-web.yml` by setting:

- Repo variable `USE_VERCEL_CLI=true`
- Repo secrets `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` (from `vercel link` locally)

## Verifying it works

```bash
# 1. Make a trivial change to apps/realtime/src/server.ts (e.g. log message)
git checkout -b ci-test
git commit -am "test: trigger deploy"
git push --set-upstream origin ci-test

# 2. Open a PR → CI should pass (no deploy yet)
# 3. Merge to main → Deploy workflow fires
# 4. Watch it in the Actions tab; should see SSM command logs streamed
# 5. After ~90 s, hit your /health endpoint — version/uptime should reflect the new commit
```

If something looks off mid-deploy, check CloudWatch Logs group `/vtm/deploys` — the SSM RunCommand output is mirrored there with retention.

## Cost

CI/CD on this project is **$0/month** on the GitHub Free plan:
- 2,000 Actions minutes/month included (we use ~3 min per PR, ~5 min per deploy)
- S3 PUT/GET for deploy artifacts is well under the 5 GB free tier
- SSM RunCommand has no per-execution charge
