# Terraform Infrastructure

Provisions everything the realtime backend needs on AWS:

- **Cognito** User Pool + Hosted UI domain + optional Google IdP
- **RDS PostgreSQL** db.t4g.micro, 20 GB gp3, encrypted, private subnet group
- **EC2** t3.micro in default VPC, Elastic IP, Caddy + Node.js + PM2 via cloud-init
- **S3** bucket for audio archive with Glacier IR lifecycle
- **IAM** instance role with least-privilege policies + SSM Session Manager
- **Security Groups** — EC2 accepts 80/443 (and SSH only if set), RDS accepts 5432 from EC2 only
- **SSM SecureString parameters** — auto-generated RDS password + `DATABASE_URL`, plus provider API keys you push via `put-secrets.sh`

All resources stay inside the AWS free tier for the first 12 months of an account.

## Quick start

```bash
cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars

terraform init
terraform plan
terraform apply

# After apply:
terraform output frontend_env_template   # paste into apps/web/.env.local
```

## Resources created

| Resource | Type | Free tier? |
|---|---|---|
| `aws_cognito_user_pool.main` | User pool | 50k MAU/month forever |
| `aws_cognito_user_pool_client.web` | SPA client | — |
| `aws_cognito_user_pool_domain.main` | Hosted UI domain | — |
| `aws_cognito_identity_provider.google` | Google IdP (optional) | — |
| `aws_db_instance.main` | RDS Postgres db.t4g.micro | 750 hr/month + 20 GB for 12 mo |
| `aws_db_subnet_group.default` | DB subnet group | — |
| `aws_security_group.rds` | RDS SG (5432 from EC2 only) | — |
| `aws_ssm_parameter.db_password` | Generated DB password | Free |
| `aws_ssm_parameter.database_url` | Full DATABASE_URL | Free |
| `aws_iam_role.ec2` + 6 policies | Instance role | — |
| `aws_iam_instance_profile.ec2` | Instance profile | — |
| `aws_security_group.realtime` | SG (ports 80/443/22) | — |
| `aws_instance.realtime` | t3.micro EC2 | 750 hr/month for 12 mo |
| `aws_eip.realtime` | Elastic IP | Free while attached |
| `aws_s3_bucket.audio` | S3 bucket | 5 GB free for 12 mo |
| `aws_s3_bucket_lifecycle_configuration.audio` | Glacier IR @ 30d, expire @ 365d | — |

## Cleanup

```bash
terraform destroy
```

The S3 bucket has `force_destroy = true` only in `environment = "dev"`. In other environments, empty it first.
