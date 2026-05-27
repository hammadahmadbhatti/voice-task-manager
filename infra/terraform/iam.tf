# EC2 instance role — least-privilege access to the resources it actually touches.

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ec2" {
  name               = "${local.name_prefix}-ec2-role"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

# RDS doesn't use IAM policies for query access — auth is via the
# DATABASE_URL credentials stored in SSM. The IAM perm we need is just
# the `ssm:GetParameter` already granted further down.

# Polly synthesize (no resource ARNs supported for this action)
data "aws_iam_policy_document" "polly" {
  statement {
    actions   = ["polly:SynthesizeSpeech"]
    resources = ["*"]
  }
}

# S3 R/W on the audio bucket only
data "aws_iam_policy_document" "s3_audio" {
  statement {
    actions   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.audio.arn}/*"]
  }
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.audio.arn]
  }
}

# Cognito describe (to validate user existence during admin flows; optional)
data "aws_iam_policy_document" "cognito_read" {
  statement {
    actions = [
      "cognito-idp:DescribeUserPool",
      "cognito-idp:DescribeUserPoolClient"
    ]
    resources = [aws_cognito_user_pool.main.arn]
  }
}

# SSM parameter read (we'll store provider API keys under /vtm/*)
data "aws_iam_policy_document" "ssm_read" {
  statement {
    actions   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
    resources = ["arn:aws:ssm:${var.aws_region}:*:parameter/${var.project}/${var.environment}/*"]
  }
}

# CloudWatch logs write
data "aws_iam_policy_document" "logs" {
  statement {
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams"
    ]
    resources = ["arn:aws:logs:${var.aws_region}:*:log-group:/${var.project}/*"]
  }
}

resource "aws_iam_role_policy" "polly" {
  name   = "polly"
  role   = aws_iam_role.ec2.id
  policy = data.aws_iam_policy_document.polly.json
}
resource "aws_iam_role_policy" "s3_audio" {
  name   = "s3-audio"
  role   = aws_iam_role.ec2.id
  policy = data.aws_iam_policy_document.s3_audio.json
}
resource "aws_iam_role_policy" "cognito_read" {
  name   = "cognito-read"
  role   = aws_iam_role.ec2.id
  policy = data.aws_iam_policy_document.cognito_read.json
}
resource "aws_iam_role_policy" "ssm_read" {
  name   = "ssm-read"
  role   = aws_iam_role.ec2.id
  policy = data.aws_iam_policy_document.ssm_read.json
}
resource "aws_iam_role_policy" "logs" {
  name   = "cloudwatch-logs"
  role   = aws_iam_role.ec2.id
  policy = data.aws_iam_policy_document.logs.json
}

# Standard managed policy: SSM Session Manager (lets us shell in without SSH)
resource "aws_iam_role_policy_attachment" "ssm_managed" {
  role       = aws_iam_role.ec2.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "ec2" {
  name = "${local.name_prefix}-ec2-profile"
  role = aws_iam_role.ec2.name
}
