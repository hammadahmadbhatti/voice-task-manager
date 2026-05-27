variable "aws_region" {
  description = "AWS region. Frankfurt (eu-central-1) recommended for EU/GDPR."
  type        = string
  default     = "eu-central-1"
}

variable "environment" {
  description = "Environment name — controls resource naming."
  type        = string
  default     = "dev"
}

variable "project" {
  description = "Project name prefix for resources."
  type        = string
  default     = "vtm"
}

# ---------- Cognito ----------

variable "cognito_callback_urls" {
  description = "Allowed OAuth callback URLs (Vercel preview + prod + localhost)."
  type        = list(string)
  default = [
    "http://localhost:3000/en/auth/callback",
    "http://localhost:3000/de/auth/callback"
  ]
}

variable "cognito_logout_urls" {
  description = "Allowed sign-out URLs."
  type        = list(string)
  default = [
    "http://localhost:3000"
  ]
}

variable "google_client_id" {
  description = "Google OAuth Client ID (leave blank to skip Google IdP)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "google_client_secret" {
  description = "Google OAuth Client Secret."
  type        = string
  default     = ""
  sensitive   = true
}

# ---------- EC2 ----------

variable "ec2_instance_type" {
  description = "EC2 instance type. t3.micro is in the AWS free tier for 12 months."
  type        = string
  default     = "t3.micro"
}

variable "ec2_key_name" {
  description = "Existing EC2 key pair name for SSH access (optional)."
  type        = string
  default     = ""
}

variable "ssh_allowed_cidrs" {
  description = "CIDR blocks permitted to SSH (port 22). Default: nowhere — set to your IP/32."
  type        = list(string)
  default     = []
}

# ---------- Domain / TLS (optional) ----------

variable "domain_name" {
  description = "Optional domain for Caddy + automatic TLS (e.g. vtm.example.com). Leave empty to use the EC2 IP over HTTP."
  type        = string
  default     = ""
}
