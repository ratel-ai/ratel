# The inputs that deploy.sh writes to terraform.tfvars. Every cloud module has the same ones
# (scripts/deploy.test.mjs checks it).

variable "name" {
  description = "The deploy's name. Every resource is named after it."
  type        = string
}

variable "region" {
  description = "The cloud's region or location."
  type        = string
}

variable "size" {
  description = "The VM type."
  type        = string
}

variable "ssh_public_key" {
  description = "The deploy's own public key. deploy.sh keeps the private key on the laptop."
  type        = string
}

variable "ssh_cidrs" {
  description = "The ranges that reach SSH: the laptop's IP, and --allow-cidr in the private mode."
  type        = list(string)
}

variable "web_cidrs" {
  description = "The ranges that reach 80 and 443. Empty in the private mode: no web port opens."
  type        = list(string)
  default     = []
}

variable "access" {
  description = "public: Caddy with TLS and a login on 80 and 443. private: no web port."
  type        = string
  default     = "public"
  validation {
    condition     = contains(["public", "private"], var.access)
    error_message = "access is public or private."
  }
}

variable "domain" {
  description = "The site name in the public mode. Empty: <ip>.sslip.io."
  type        = string
  default     = ""
}

variable "tls" {
  description = "acme (Let's Encrypt) or internal (Caddy's own CA, when 80 is closed to the internet)."
  type        = string
  default     = "acme"
  validation {
    condition     = contains(["acme", "internal"], var.tls)
    error_message = "tls is acme or internal."
  }
}

variable "ref" {
  description = "The branch, tag or commit that install.sh checks out."
  type        = string
  default     = "main"
}

variable "install_url" {
  description = "Where the VM downloads install.sh."
  type        = string
  default     = "https://raw.githubusercontent.com/ratel-ai/ratel/main/install.sh"
}

variable "project" {
  description = "The Google Cloud project: gcloud's project on the laptop."
  type        = string
}
