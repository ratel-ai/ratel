# Ratel on one AWS EC2 VM: Ubuntu 24.04 LTS in the default VPC, an Elastic IP and a security
# group of its own. The default VPC is enough: the security group is the only one on the VM.

terraform {
  required_version = ">= 1.5.7"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { "ratel-deploy" = var.name }
  }
}

locals {
  public_ip = aws_eip.ratel.public_ip
  # Graviton types (t4g, m7g, c7gn...) need the arm64 image.
  arch = can(regex("^[a-z]+[0-9]+[a-z]*g[a-z]*\\.", var.size)) ? "arm64" : "amd64"
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

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

# Canonical's account.
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-${local.arch}-server-*"]
  }
}

resource "aws_security_group" "ratel" {
  name        = var.name
  description = "Ratel: SSH from the deploy's laptop, and 80 and 443 in the public mode"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = var.ssh_cidrs
  }

  dynamic "ingress" {
    for_each = length(var.web_cidrs) > 0 ? [80, 443] : []
    content {
      description = "HTTP and HTTPS to Caddy"
      from_port   = ingress.value
      to_port     = ingress.value
      protocol    = "tcp"
      cidr_blocks = var.web_cidrs
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_eip" "ratel" {
  domain = "vpc"
  tags   = { Name = var.name }
}

resource "aws_instance" "ratel" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.size
  subnet_id              = sort(data.aws_subnets.default.ids)[0]
  vpc_security_group_ids = [aws_security_group.ratel.id]
  user_data              = module.host.user_data

  root_block_device {
    volume_size = 30
    volume_type = "gp3"
    encrypted   = true
  }

  metadata_options {
    http_tokens = "required"
  }

  tags = { Name = var.name }

  # A new image or new user data must not replace the VM and its data. Upgrades run install.sh
  # over SSH instead.
  lifecycle {
    ignore_changes = [ami, user_data]
  }
}

resource "aws_eip_association" "ratel" {
  instance_id   = aws_instance.ratel.id
  allocation_id = aws_eip.ratel.id
}
