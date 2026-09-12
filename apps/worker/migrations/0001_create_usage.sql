CREATE TABLE users (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	github_login TEXT NOT NULL UNIQUE,
	avatar_url TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE api_keys (
	key_hash TEXT PRIMARY KEY,
	user_id INTEGER NOT NULL REFERENCES users(id),
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	revoked_at TEXT
);

CREATE TABLE machines (
	user_id INTEGER NOT NULL REFERENCES users(id),
	machine_id TEXT NOT NULL,
	last_seen TEXT NOT NULL,
	PRIMARY KEY (user_id, machine_id)
);

CREATE TABLE usage_days (
	user_id INTEGER NOT NULL REFERENCES users(id),
	machine_id TEXT NOT NULL,
	date TEXT NOT NULL,
	provider TEXT NOT NULL,
	model TEXT NOT NULL,
	input INTEGER NOT NULL,
	output INTEGER NOT NULL,
	cache_create INTEGER NOT NULL,
	cache_read INTEGER NOT NULL,
	cost_usd REAL NOT NULL,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (user_id, machine_id, date, provider, model)
);

CREATE INDEX usage_days_user_date
	ON usage_days (user_id, date);
