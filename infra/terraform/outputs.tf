output "ec2_public_ip" {
  description = "Elastic IP of the realtime server"
  value       = aws_eip.realtime.public_ip
}

output "ec2_instance_id" {
  description = "EC2 instance ID (use with `aws ssm start-session --target ...`)"
  value       = aws_instance.realtime.id
}

output "rds_endpoint" {
  description = "RDS Postgres endpoint (host:port). Used by the EC2 backend only."
  value       = aws_db_instance.main.endpoint
}

output "rds_database_name" {
  description = "Database name on RDS"
  value       = aws_db_instance.main.db_name
}

output "cognito_user_pool_id" {
  description = "Cognito User Pool ID — put into apps/realtime/.env and apps/web/.env.local"
  value       = aws_cognito_user_pool.main.id
}

output "cognito_client_id" {
  description = "Cognito App Client ID — public, used by the SPA"
  value       = aws_cognito_user_pool_client.web.id
}

output "cognito_domain" {
  description = "Cognito Hosted UI domain (without scheme)"
  value       = "${aws_cognito_user_pool_domain.main.domain}.auth.${var.aws_region}.amazoncognito.com"
}

output "audio_bucket" {
  description = "S3 bucket for archived conversation audio"
  value       = aws_s3_bucket.audio.id
}

output "frontend_env_template" {
  description = "Paste into apps/web/.env.local"
  value       = <<-EOT
    NEXT_PUBLIC_WS_URL=${var.domain_name != "" ? "https://${var.domain_name}" : "http://${aws_eip.realtime.public_ip}"}
    NEXT_PUBLIC_API_URL=${var.domain_name != "" ? "https://${var.domain_name}" : "http://${aws_eip.realtime.public_ip}"}
    NEXT_PUBLIC_COGNITO_DOMAIN=${aws_cognito_user_pool_domain.main.domain}.auth.${var.aws_region}.amazoncognito.com
    NEXT_PUBLIC_COGNITO_CLIENT_ID=${aws_cognito_user_pool_client.web.id}
    NEXT_PUBLIC_COGNITO_REDIRECT_URI=https://YOUR-VERCEL-URL/en/auth/callback
    NEXT_PUBLIC_DEFAULT_LOCALE=en
    NEXT_PUBLIC_ALLOW_ANONYMOUS=false
  EOT
}
