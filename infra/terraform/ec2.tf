# EC2 t3.micro in the default VPC public subnet.
# Free tier: 750 hours/month for 12 months.
# Caddy fronts the Node process and handles TLS automatically when a
# `domain_name` is configured.

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-jammy-22.04-amd64-server-*"]
  }
  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
}

resource "aws_security_group" "realtime" {
  name        = "${local.name_prefix}-realtime-sg"
  description = "Voice Task Manager realtime server"
  vpc_id      = data.aws_vpc.default.id

  # Inbound: HTTPS (Caddy → Node) for end users
  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  # Inbound: HTTP (only used during initial Caddy cert issuance + local testing)
  ingress {
    description = "HTTP (ACME http-01 + bootstrap)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  # Inbound: SSH only from explicitly allowed CIDRs (default: none)
  dynamic "ingress" {
    for_each = length(var.ssh_allowed_cidrs) > 0 ? [1] : []
    content {
      description = "SSH"
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = var.ssh_allowed_cidrs
    }
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

locals {
  ec2_userdata = templatefile("${path.module}/userdata.sh.tftpl", {
    domain_name       = var.domain_name
    aws_region        = var.aws_region
    cognito_pool_id   = aws_cognito_user_pool.main.id
    cognito_client_id = aws_cognito_user_pool_client.web.id
    audio_bucket      = aws_s3_bucket.audio.id
    project           = var.project
    environment       = var.environment
  })
}

resource "aws_instance" "realtime" {
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = var.ec2_instance_type
  subnet_id                   = data.aws_subnets.default.ids[0]
  vpc_security_group_ids      = [aws_security_group.realtime.id]
  iam_instance_profile        = aws_iam_instance_profile.ec2.name
  associate_public_ip_address = true
  key_name                    = var.ec2_key_name != "" ? var.ec2_key_name : null
  user_data                   = local.ec2_userdata
  user_data_replace_on_change = true

  root_block_device {
    volume_size = 20 # GiB (free tier covers 30 GiB EBS)
    volume_type = "gp3"
    encrypted   = true
  }

  metadata_options {
    http_tokens   = "required" # IMDSv2 only
    http_endpoint = "enabled"
  }

  tags = {
    Name = "${local.name_prefix}-realtime"
  }
}

# Static IP so DNS doesn't break on reboot.
resource "aws_eip" "realtime" {
  instance = aws_instance.realtime.id
  domain   = "vpc"

  tags = {
    Name = "${local.name_prefix}-realtime-eip"
  }
}
