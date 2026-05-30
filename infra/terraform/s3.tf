# S3 bucket for archived conversation audio (for analytics / debug).
# Lifecycle: move to Glacier Instant Retrieval at 30 days, expire at 365.

resource "aws_s3_bucket" "audio" {
  bucket        = "${local.name_prefix}-audio-${random_id.cognito_domain.hex}"
  force_destroy = var.environment == "dev"
}

resource "aws_s3_bucket_public_access_block" "audio" {
  bucket                  = aws_s3_bucket.audio.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "audio" {
  bucket = aws_s3_bucket.audio.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "audio" {
  bucket = aws_s3_bucket.audio.id

  rule {
    id     = "archive-then-expire"
    status = "Enabled"

    # Empty filter = applies to every object in the bucket.
    # Required by AWS provider v4+: each rule must declare exactly one of
    # `filter` or `prefix`. Omitting both is a deprecation warning today
    # and an error in future provider versions.
    filter {}

    transition {
      days          = 30
      storage_class = "GLACIER_IR"
    }
    expiration {
      days = 365
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}
