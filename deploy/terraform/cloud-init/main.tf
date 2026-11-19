# What every cloud module shares: the cloud-init user data that runs install.sh on the VM, and
# the console password of the public mode. Each cloud module calls it as module "host".
#
# The password stays in the Terraform state on the laptop (~/.ratel/deploy/<name>/). The VM
# gets only its bcrypt hash, for Caddy's basic auth.

terraform {
  required_version = ">= 1.5.7"
  required_providers {
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

variable "public_ip" {
  description = "The VM's static public IPv4 address."
  type        = string
}

variable "ssh_public_key" {
  description = "The deploy's own public key, for the ratel user."
  type        = string
}

variable "access" {
  description = "public: Caddy with TLS and a login on 80 and 443. private: no web port."
  type        = string
}

variable "domain" {
  description = "The site name in the public mode. Empty: <public_ip>.sslip.io."
  type        = string
}

variable "tls" {
  description = "acme (Let's Encrypt) or internal (Caddy's own CA)."
  type        = string
}

variable "ref" {
  description = "The branch, tag or commit that install.sh checks out."
  type        = string
}

variable "install_url" {
  description = "Where the VM downloads install.sh."
  type        = string
}

resource "random_password" "console" {
  count   = var.access == "public" ? 1 : 0
  length  = 24
  special = false
}

locals {
  domain = var.access != "public" ? "" : (var.domain != "" ? var.domain : "${var.public_ip}.sslip.io")
  access_args = var.access != "public" ? "--access private" : join(" ", [
    "--access public",
    "--domain '${local.domain}'",
    "--tls '${var.tls}'",
    "--auth-hash '${random_password.console[0].bcrypt_hash}'",
  ])
}

output "user_data" {
  description = "The cloud-config for the VM."
  sensitive   = true
  value = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    ssh_public_key = var.ssh_public_key
    install_url    = var.install_url
    ref            = var.ref
    install_dir    = "/opt/ratel"
    access_args    = local.access_args
  })
}

output "domain" {
  description = "The site name in the public mode, else empty."
  value       = local.domain
}

output "url" {
  description = "The console's address in the public mode, else empty."
  value       = local.domain == "" ? "" : "https://${local.domain}"
}

output "password" {
  description = "The console password of the public mode, else empty."
  sensitive   = true
  value       = var.access == "public" ? random_password.console[0].result : ""
}
