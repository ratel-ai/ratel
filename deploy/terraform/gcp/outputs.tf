# The outputs that deploy.sh reads. Every cloud module has the same ones.

output "public_ip" {
  description = "The VM's static public IPv4 address."
  value       = local.public_ip
}

output "ssh_user" {
  description = "The user that cloud-init creates with the deploy's key."
  value       = "ratel"
}

output "domain" {
  description = "The site name in the public mode, else empty."
  value       = module.host.domain
}

output "url" {
  description = "The console's address in the public mode, else empty."
  value       = module.host.url
}

output "password" {
  description = "The console password of the public mode, else empty. It stays in this state."
  sensitive   = true
  value       = module.host.password
}
