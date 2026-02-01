terraform {
  backend "s3" {
    key          = "openclaw/terraform.tfstate"
    encrypt      = true
    use_lockfile = true
  }
}
