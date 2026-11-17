# Ratel on one Hetzner Cloud server: Ubuntu 24.04 LTS, a primary IP of its own that outlives a
# server replacement, and a firewall. The SSH key is registered so that Hetzner sends no root
# password. The cx types exist only in the EU locations (nbg1, fsn1, hel1).

terraform {
  required_version = ">= 1.6.0"
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.50"
    }
  }
}

# The token comes from HCLOUD_TOKEN, which deploy.sh takes from the hcloud context when unset.
provider "hcloud" {}

locals {
  public_ip = hcloud_primary_ip.ratel.ip_address
  labels    = { "ratel-deploy" = var.name }
}

module "host" {
  source         = "../cloud-init"
  public_ip      = local.public_ip
  ssh_public_key = var.ssh_public_key
  access         = var.access
  domain         = var.domain
  tls            = var.tls
  ref            = var.ref
  install_url    = var.install_url
}

resource "hcloud_ssh_key" "ratel" {
  name       = "ratel-deploy-${var.name}"
  public_key = var.ssh_public_key
  labels     = local.labels
}

resource "hcloud_primary_ip" "ratel" {
  name        = var.name
  location    = var.region
  type        = "ipv4"
  auto_delete = false
  labels      = local.labels
}

resource "hcloud_firewall" "ratel" {
  name   = var.name
  labels = local.labels

  rule {
    description = "SSH"
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = var.ssh_cidrs
  }

  dynamic "rule" {
    for_each = length(var.web_cidrs) > 0 ? ["80", "443"] : []
    content {
      description = "HTTP and HTTPS to Caddy"
      direction   = "in"
      protocol    = "tcp"
      port        = rule.value
      source_ips  = var.web_cidrs
    }
  }
}

resource "hcloud_server" "ratel" {
  name         = var.name
  server_type  = var.size
  location     = var.region
  image        = "ubuntu-24.04"
  ssh_keys     = [hcloud_ssh_key.ratel.id]
  firewall_ids = [hcloud_firewall.ratel.id]
  user_data    = module.host.user_data
  labels       = local.labels

  public_net {
    ipv4_enabled = true
    ipv4         = hcloud_primary_ip.ratel.id
    ipv6_enabled = false
  }

  # New user data or a new image would replace the server and its data. Upgrades run
  # install.sh over SSH instead.
  lifecycle {
    ignore_changes = [user_data, image]
  }
}
