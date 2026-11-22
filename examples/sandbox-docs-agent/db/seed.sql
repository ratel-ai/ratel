-- The tickets table of the docs agent, run once when the Postgres sidecar starts.
-- The same table as src/tickets.ts creates; SQLite is the local default.
CREATE TABLE IF NOT EXISTS tickets (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
