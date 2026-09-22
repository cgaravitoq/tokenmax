-- The hostname in front of the platform identifier changed with the network, so
-- one machine was stored under an id per network it joined. unhex() reads the
-- trailing identifier: a uuid is 32 hex digits split by four dashes, and a Linux
-- machine id is 32 lowercase hex digits.
CREATE TABLE machine_aliases AS
SELECT DISTINCT machine_id,
	CASE
		WHEN length(replace(substr(machine_id, -36), '-', '')) = 32
			AND unhex(replace(substr(machine_id, -36), '-', '')) IS NOT NULL
			THEN substr(machine_id, -36)
		WHEN substr(machine_id, -32) = lower(substr(machine_id, -32))
			AND unhex(substr(machine_id, -32)) IS NOT NULL
			THEN substr(machine_id, -32)
		ELSE machine_id
	END AS canonical_id
FROM (
	SELECT machine_id FROM machines
	UNION
	SELECT machine_id FROM usage_days
);

CREATE TABLE usage_days_canonical (
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

INSERT INTO usage_days_canonical (
	user_id, machine_id, date, provider, model, input, output, cache_create,
	cache_read, cost_usd, updated_at
)
SELECT
	usage_days.user_id,
	machine_aliases.canonical_id,
	usage_days.date,
	usage_days.provider,
	usage_days.model,
	max(usage_days.input),
	max(usage_days.output),
	max(usage_days.cache_create),
	max(usage_days.cache_read),
	max(usage_days.cost_usd),
	max(usage_days.updated_at)
FROM usage_days
JOIN machine_aliases ON machine_aliases.machine_id = usage_days.machine_id
GROUP BY
	usage_days.user_id,
	machine_aliases.canonical_id,
	usage_days.date,
	usage_days.provider,
	usage_days.model;

DROP TABLE usage_days;

ALTER TABLE usage_days_canonical RENAME TO usage_days;

CREATE INDEX usage_days_user_date
	ON usage_days (user_id, date);

CREATE TABLE machines_canonical (
	user_id INTEGER NOT NULL REFERENCES users(id),
	machine_id TEXT NOT NULL,
	last_seen TEXT NOT NULL,
	timezone TEXT NOT NULL DEFAULT 'UTC',
	PRIMARY KEY (user_id, machine_id)
);

-- The bare timezone travels with max(last_seen): the alias seen last decides.
INSERT INTO machines_canonical (user_id, machine_id, last_seen, timezone)
SELECT
	machines.user_id,
	machine_aliases.canonical_id,
	max(machines.last_seen),
	machines.timezone
FROM machines
JOIN machine_aliases ON machine_aliases.machine_id = machines.machine_id
GROUP BY machines.user_id, machine_aliases.canonical_id;

DROP TABLE machines;

ALTER TABLE machines_canonical RENAME TO machines;

DROP TABLE machine_aliases;
