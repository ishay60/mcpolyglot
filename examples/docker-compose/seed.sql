-- Sample fintech schema. All data is fictional.
CREATE TABLE customers (
  id         SERIAL PRIMARY KEY,
  full_name  TEXT NOT NULL,
  email      TEXT NOT NULL UNIQUE,
  ssn        TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id            SERIAL PRIMARY KEY,
  customer_id   INTEGER NOT NULL REFERENCES customers(id),
  kind          TEXT NOT NULL CHECK (kind IN ('checking', 'savings')),
  balance_cents BIGINT NOT NULL DEFAULT 0,
  opened_at     DATE NOT NULL DEFAULT CURRENT_DATE
);

CREATE TABLE transactions (
  id           SERIAL PRIMARY KEY,
  account_id   INTEGER NOT NULL REFERENCES accounts(id),
  amount_cents BIGINT NOT NULL,
  description  TEXT,
  posted_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO customers (full_name, email, ssn) VALUES
  ('Ada Park',    'ada@example.com',    '000-12-3456'),
  ('Lin Moreau',  'lin@example.com',    '000-23-4567'),
  ('Sam Okafor',  'sam@example.com',    '000-34-5678');

INSERT INTO accounts (customer_id, kind, balance_cents) VALUES
  (1, 'checking', 250000), (1, 'savings', 1200000),
  (2, 'checking',  83050), (3, 'checking',   4200);

INSERT INTO transactions (account_id, amount_cents, description, posted_at) VALUES
  (1, -4599,  'Grocery store',     now() - interval '3 days'),
  (1, 320000, 'Payroll deposit',   now() - interval '2 days'),
  (2, 50000,  'Transfer in',       now() - interval '2 days'),
  (3, -12000, 'Utility bill',      now() - interval '1 day'),
  (4, -899,   'Streaming service', now());

-- Read-only login for the agent. The policy is the first wall; this is the second.
CREATE ROLE agent_ro LOGIN PASSWORD 'agent-ro-dev-only';
GRANT CONNECT ON DATABASE bank TO agent_ro;
GRANT USAGE ON SCHEMA public TO agent_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO agent_ro;
