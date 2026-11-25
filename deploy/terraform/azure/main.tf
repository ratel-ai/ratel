# Ratel on one Azure VM: Ubuntu 24.04 LTS in a resource group of its own, with a virtual
# network, a network security group and a static public IP. Azure has no default network, so
# the module creates one.

terraform {
  required_version = ">= 1.5.7"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }
}

# The subscription comes from ARM_SUBSCRIPTION_ID, which deploy.sh takes from `az account show`.
provider "azurerm" {
  features {}
}

locals {
  public_ip = azurerm_public_ip.ratel.ip_address
  # Arm sizes (D2ps_v5, B2pls_v2...) have a "p" after the vCPU count and need the arm64 image.
  arch_sku = can(regex("^Standard_[A-Z]+[0-9]+[a-z]*p", var.size)) ? "server-arm64" : "server"
  tags     = { "ratel-deploy" = var.name }
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

resource "azurerm_resource_group" "ratel" {
  name     = var.name
  location = var.region
  tags     = local.tags
}

resource "azurerm_virtual_network" "ratel" {
  name                = var.name
  location            = azurerm_resource_group.ratel.location
  resource_group_name = azurerm_resource_group.ratel.name
  address_space       = ["10.42.0.0/16"]
  tags                = local.tags
}

resource "azurerm_subnet" "ratel" {
  name                 = var.name
  resource_group_name  = azurerm_resource_group.ratel.name
  virtual_network_name = azurerm_virtual_network.ratel.name
  address_prefixes     = ["10.42.1.0/24"]
}

resource "azurerm_network_security_group" "ratel" {
  name                = var.name
  location            = azurerm_resource_group.ratel.location
  resource_group_name = azurerm_resource_group.ratel.name
  tags                = local.tags

  security_rule {
    name                       = "ssh"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefixes    = var.ssh_cidrs
    destination_address_prefix = "*"
  }

  dynamic "security_rule" {
    for_each = length(var.web_cidrs) > 0 ? [1] : []
    content {
      name                       = "web"
      priority                   = 110
      direction                  = "Inbound"
      access                     = "Allow"
      protocol                   = "Tcp"
      source_port_range          = "*"
      destination_port_ranges    = ["80", "443"]
      source_address_prefixes    = var.web_cidrs
      destination_address_prefix = "*"
    }
  }
}

resource "azurerm_public_ip" "ratel" {
  name                = var.name
  location            = azurerm_resource_group.ratel.location
  resource_group_name = azurerm_resource_group.ratel.name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = local.tags
}

resource "azurerm_network_interface" "ratel" {
  name                = var.name
  location            = azurerm_resource_group.ratel.location
  resource_group_name = azurerm_resource_group.ratel.name
  tags                = local.tags

  ip_configuration {
    name                          = "primary"
    subnet_id                     = azurerm_subnet.ratel.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.ratel.id
  }
}

resource "azurerm_network_interface_security_group_association" "ratel" {
  network_interface_id      = azurerm_network_interface.ratel.id
  network_security_group_id = azurerm_network_security_group.ratel.id
}

resource "azurerm_linux_virtual_machine" "ratel" {
  name                  = var.name
  location              = azurerm_resource_group.ratel.location
  resource_group_name   = azurerm_resource_group.ratel.name
  size                  = var.size
  admin_username        = "ratel"
  network_interface_ids = [azurerm_network_interface.ratel.id]
  custom_data           = base64encode(module.host.user_data)
  tags                  = local.tags

  admin_ssh_key {
    username   = "ratel"
    public_key = var.ssh_public_key
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "StandardSSD_LRS"
    disk_size_gb         = 30
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = local.arch_sku
    version   = "latest"
  }

  # New user data must not replace the VM and its data. Upgrades run install.sh over SSH instead.
  lifecycle {
    ignore_changes = [custom_data]
  }
}
