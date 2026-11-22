# Deploy Ratel to Google Cloud

<walkthrough-tutorial-duration duration="10"></walkthrough-tutorial-duration>

This tutorial runs `deploy.sh` in Cloud Shell. It creates one Compute Engine VM with Ratel on it, in a project that you choose. It shows the plan and the monthly cost, and it asks before it creates anything.

## Choose a project

<walkthrough-project-setup billing="true"></walkthrough-project-setup>

Set it for `gcloud`:

```sh
gcloud config set project <walkthrough-project-id/>
```

Turn on the Compute Engine API:

```sh
gcloud services enable compute.googleapis.com
```

## Deploy

The public mode (default) puts Caddy with TLS and a login in front of the console. The password is printed once, at the end:

```sh
./deploy.sh up --cloud gcp
```

For no web port, and a console that you reach through an SSH tunnel:

```sh
./deploy.sh up --cloud gcp --access private
```

Other options: `--region`, `--size`, `--domain`, `--allow-cidr` and `--ref`. See "Deploy to your cloud" in the README.

## Keep the state

The state, the SSH key and the password are in `~/.ratel/deploy/ratel/`. Cloud Shell keeps your home directory, so `status`, upgrades and `destroy` work from here later:

```sh
./deploy.sh status
./deploy.sh destroy
```

<walkthrough-conclusion-trophy></walkthrough-conclusion-trophy>

Ratel is running. Open the URL that `deploy.sh` printed.
