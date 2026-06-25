bucket         = "replace-with-your-opentofu-state-bucket"
key            = "maximal/staging/terraform.tfstate"
region         = "us-east-1"
dynamodb_table = "replace-with-your-opentofu-lock-table"
encrypt        = true
