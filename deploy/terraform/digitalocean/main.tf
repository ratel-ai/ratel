# Ratel on one DigitalOcean Droplet: Ubuntu 24.04 LTS in the region's default VPC, a reserved
# IP and a cloud firewall. The SSH key is registered so that DigitalOcean sends no root password.

terraform {
  required_version = ">= 1.5.7"
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.0"
    }
  }
}

# The token comes from DIGITALOCEAN_TOKEN, which deploy.sh takes from doctl when it is unset.
provider "digitalocean" {}

locals {
  public_ip = digitalocean_reserved_ip.ratel.ip_address
}

module "host" {
  source         = "../cloud-init"
  public_ip      = local.public_ip
  ssh_public_key = var.ssh_public_key
  access         = var.access
  domain         = var.domain
  tls            = var.tls
  ratel_version  = var.ratel_version
  ref            = var.ref
  install_url    = var.install_url
}

resource "digitalocean_ssh_key" "ratel" {
  name       = "ratel-deploy-${var.name}"
  public_key = var.ssh_public_key
}

resource "digitalocean_reserved_ip" "ratel" {
  region = var.region
}

resource "digitalocean_droplet" "ratel" {
  name      = var.name
  region    = var.region
  size      = var.size
  image     = "ubuntu-24-04-x64"
  ssh_keys  = [digitalocean_ssh_key.ratel.fingerprint]
  user_data = module.host.user_data
  tags      = ["ratel-deploy"]

  # New user data or a new image would replace the Droplet and its data. Upgrades run
  # install.sh over SSH instead.
  lifecycle {
    ignore_changes = [user_data, image]
  }
}

resource "digitalocean_reserved_ip_assignment" "ratel" {
  ip_address = digitalocean_reserved_ip.ratel.ip_address
  droplet_id = digitalocean_droplet.ratel.id
}

resource "digitalocean_firewall" "ratel" {
  name        = var.name
  droplet_ids = [digitalocean_droplet.ratel.id]

  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = var.ssh_cidrs
  }

  dynamic "inbound_rule" {
    for_each = length(var.web_cidrs) > 0 ? ["80", "443"] : []
    content {
      protocol         = "tcp"
      port_range       = inbound_rule.value
      source_addresses = var.web_cidrs
    }
  }

  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}
