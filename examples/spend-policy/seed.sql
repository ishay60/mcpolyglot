-- Generic fintech schema. All data is fictional.
CREATE TABLE customers (id INTEGER PRIMARY KEY, full_name TEXT NOT NULL, ssn TEXT);
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  balance_cents INTEGER NOT NULL
);
-- The database enforces the per-transaction spend cap: no single debit over $500.
CREATE TABLE transactions (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= -50000),
  memo TEXT
);
INSERT INTO customers (full_name, ssn) VALUES ('Ada Park', '000-12-3456'), ('Lin Moreau', '000-23-4567');
INSERT INTO accounts (customer_id, balance_cents) VALUES (1, 250000), (2, 83050);
INSERT INTO transactions (account_id, amount_cents, memo) VALUES (1, -4599, 'Groceries'), (2, 320000, 'Payroll');
