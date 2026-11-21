# Quick start

Ratel is a self-hosted platform for AI agents. Your agent sends it traces and its catalog of tools and skills. Ratel shows what the agent gets wrong, what people ask it for, and which changes would help.

It runs as one application and one Postgres database. To start it on your machine:

```sh
git clone https://github.com/ratel-ai/ratel.git
cd ratel
docker compose up -d --build --wait
```

Open http://localhost:3000. No configuration is needed. If port 3000 or 5432 is taken, set `RATEL_PORT` and `RATEL_DB_PORT` in `.env` and set `BASE_URL` to the address you open.
