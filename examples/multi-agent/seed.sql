-- Sample support/billing schema. All data is fictional.
CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT NOT NULL, plan TEXT NOT NULL);
CREATE TABLE invoices (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, amount_cents INTEGER NOT NULL, status TEXT NOT NULL);
CREATE TABLE tickets (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, subject TEXT NOT NULL, status TEXT NOT NULL);
INSERT INTO customers (email, plan) VALUES ('ada@example.com', 'pro'), ('lin@example.com', 'free');
INSERT INTO invoices (customer_id, amount_cents, status) VALUES (1, 4900, 'paid'), (1, 4900, 'open'), (2, 0, 'paid');
INSERT INTO tickets (customer_id, subject, status) VALUES (1, 'Export is slow', 'open'), (2, 'Change email', 'open');
