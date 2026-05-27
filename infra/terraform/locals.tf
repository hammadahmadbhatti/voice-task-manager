locals {
  name_prefix = "${var.project}-${var.environment}"
}

# Random suffix for the Cognito Hosted-UI domain (must be globally unique).
resource "random_id" "cognito_domain" {
  byte_length = 4
  keepers = {
    project = var.project
  }
}
