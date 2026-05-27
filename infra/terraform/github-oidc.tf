# GitHub Actions OIDC trust + deploy role.
# Lets GitHub Actions assume an AWS role *without* long-lived access keys
# stored as repo secrets. Instead, each workflow run mints a short-lived
# OIDC token that AWS STS exchanges for temporary credentials.
#
# To enable:
#   1. Set var.github_repo to "<owner>/<repo>" in terraform.tfvars
#   2. terraform apply
#   3. Copy outputs (github_actions_role_arn, etc.) into GitHub repo
#      Settings → Secrets and variables → Actions → Variables.

variable "github_repo" {
  description = <<-EOT
    GitHub repo in `owner/repo` format. Empty disables the OIDC role.
    Example: "hammadbhatti18777/voice-task-manager"
  EOT
  type        = string
  default     = ""
}

variable "github_branches" {
  description = "Branch refs allowed to assume the deploy role. Tags get a separate condition below."
  type        = list(string)
  default     = ["main"]
}

# OIDC provider. One per AWS account — guarded with `count` so it doesn't
# fail if you've already created it for another project.
resource "aws_iam_openid_connect_provider" "github" {
  count = var.github_repo != "" ? 1 : 0

  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  # GitHub's OIDC thumbprints — AWS now validates by JWKS but the field is required.
  thumbprint_list = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c58a3a8518e8759bf075b76b750d4f2df264fcd"
  ]
}

data "aws_iam_policy_document" "github_assume" {
  count = var.github_repo != "" ? 1 : 0

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github[0].arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    # Pin to specific branches in this repo. Pull requests get a *different*
    # subject (`pull_request`) and are deliberately NOT allowed to deploy.
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values = concat(
        [for b in var.github_branches : "repo:${var.github_repo}:ref:refs/heads/${b}"],
        ["repo:${var.github_repo}:environment:production"]
      )
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  count              = var.github_repo != "" ? 1 : 0
  name               = "${local.name_prefix}-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.github_assume[0].json
  description        = "Assumed by GitHub Actions to deploy the realtime backend"
  max_session_duration = 3600
}

# Permissions needed by the deploy workflow:
#   - put deploy artifact to a dedicated S3 prefix
#   - SSM RunCommand on the realtime EC2 instance
#   - read EC2 instance metadata (to find the instance)
data "aws_iam_policy_document" "github_deploy" {
  count = var.github_repo != "" ? 1 : 0

  # S3 — upload artifacts under deploys/ prefix on the audio bucket
  # (re-using the bucket avoids creating another paid resource).
  statement {
    sid     = "ArtifactUpload"
    actions = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
    resources = [
      "${aws_s3_bucket.audio.arn}/deploys/*"
    ]
  }
  statement {
    sid       = "ArtifactBucketList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.audio.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["deploys/*"]
    }
  }

  # SSM — run the deploy command on our instance only
  statement {
    sid     = "RunCommand"
    actions = ["ssm:SendCommand"]
    resources = [
      "arn:aws:ssm:${var.aws_region}::document/AWS-RunShellScript",
      aws_instance.realtime.arn
    ]
  }
  statement {
    sid     = "CommandStatus"
    actions = ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations", "ssm:ListCommands"]
    resources = ["*"]
  }

  # Describe EC2 to look up instance by tag
  statement {
    sid       = "DescribeEC2"
    actions   = ["ec2:DescribeInstances"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  count  = var.github_repo != "" ? 1 : 0
  name   = "deploy"
  role   = aws_iam_role.github_deploy[0].id
  policy = data.aws_iam_policy_document.github_deploy[0].json
}

# Outputs are exposed conditionally — Terraform doesn't allow a `count` on
# `output`, so we emit empty strings when disabled.
output "github_actions_role_arn" {
  description = "Set this as the GitHub repo variable AWS_DEPLOY_ROLE_ARN"
  value       = try(aws_iam_role.github_deploy[0].arn, "")
}

output "github_actions_artifact_bucket" {
  description = "Set this as the GitHub repo variable DEPLOY_BUCKET"
  value       = aws_s3_bucket.audio.id
}

output "github_actions_instance_id" {
  description = "Set this as the GitHub repo variable EC2_INSTANCE_ID"
  value       = aws_instance.realtime.id
}
