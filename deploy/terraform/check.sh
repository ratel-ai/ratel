#!/bin/sh
# Checks the deploy modules with one engine: the format, then init and validate in each cloud
# module. It logs in to no cloud and creates nothing.
#
#   deploy/terraform/check.sh tofu
#   deploy/terraform/check.sh terraform
set -eu

engine=${1:-tofu}
root=$(cd "$(dirname "$0")" && pwd)

"$engine" -chdir="$root" fmt -check -recursive -diff
echo "fmt: ok ($engine)"
for cloud in aws gcp azure digitalocean hetzner; do
  printf '%s: ' "$cloud"
  "$engine" -chdir="$root/$cloud" init -backend=false -input=false >/dev/null
  "$engine" -chdir="$root/$cloud" validate -no-color
  rm -rf "$root/$cloud/.terraform" "$root/$cloud/.terraform.lock.hcl"
done
