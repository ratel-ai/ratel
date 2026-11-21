# Ratel on one Google Compute Engine VM: Ubuntu 24.04 LTS, a static external IP and a network
# of its own. The project's "default" network allows SSH from anywhere, so it is not used.

terraform {
  required_version = ">= 1.5.7"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }
}

provider "google" {
  project = var.project
  region  = var.region
  default_labels = {
    "ratel-deploy" = var.name
  }
}

locals {
  public_ip = google_compute_address.ratel.address
  # Arm machine types (t2a, c4a, n4a) need the arm64 image.
  arch = can(regex("^(t2a|c4a|n4a)-", var.size)) ? "arm64" : "amd64"
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

data "google_compute_zones" "up" {
  region = var.region
  status = "UP"
}

resource "google_compute_network" "ratel" {
  name                    = var.name
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "ratel" {
  name          = var.name
  network       = google_compute_network.ratel.id
  region        = var.region
  ip_cidr_range = "10.42.0.0/24"
}

resource "google_compute_firewall" "ssh" {
  name          = "${var.name}-ssh"
  network       = google_compute_network.ratel.id
  source_ranges = var.ssh_cidrs
  target_tags   = [var.name]
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

resource "google_compute_firewall" "web" {
  count         = length(var.web_cidrs) > 0 ? 1 : 0
  name          = "${var.name}-web"
  network       = google_compute_network.ratel.id
  source_ranges = var.web_cidrs
  target_tags   = [var.name]
  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }
}

resource "google_compute_address" "ratel" {
  name   = var.name
  region = var.region
}

resource "google_compute_instance" "ratel" {
  name         = var.name
  machine_type = var.size
  zone         = data.google_compute_zones.up.names[0]
  tags         = [var.name]

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2404-lts-${local.arch}"
      size  = 30
      type  = "pd-balanced"
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.ratel.id
    access_config {
      nat_ip = google_compute_address.ratel.address
    }
  }

  metadata = {
    user-data = module.host.user_data
  }

  # A new image or new user data must not replace the VM and its data. Upgrades run install.sh
  # over SSH instead.
  lifecycle {
    ignore_changes = [metadata, boot_disk[0].initialize_params[0].image]
  }
}
