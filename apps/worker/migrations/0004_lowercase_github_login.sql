-- lowercasing two logins that differ only in case collides on
-- users.github_login, so each case variant is folded into the lowest users.id
-- of its group. A machine or a usage day held by both rows keeps the newest
-- write before it moves, because usage_days is last-write-wins.
DELETE FROM usage_days
WHERE rowid NOT IN (
	SELECT winner FROM (
		SELECT usage_days.rowid AS winner,
			ROW_NUMBER() OVER (
				PARTITION BY usage_days.machine_id, usage_days.date,
					usage_days.provider, usage_days.model,
					lower(users.github_login)
				ORDER BY usage_days.updated_at DESC, usage_days.user_id
			) AS rank
		FROM usage_days
		JOIN users ON users.id = usage_days.user_id
	) WHERE rank = 1
);

DELETE FROM machines
WHERE rowid NOT IN (
	SELECT winner FROM (
		SELECT machines.rowid AS winner,
			ROW_NUMBER() OVER (
				PARTITION BY machines.machine_id, lower(users.github_login)
				ORDER BY machines.last_seen DESC, machines.user_id
			) AS rank
		FROM machines
		JOIN users ON users.id = machines.user_id
	) WHERE rank = 1
);

UPDATE usage_days
SET user_id = (
	SELECT MIN(id) FROM users
	WHERE lower(github_login) = (
		SELECT lower(github_login) FROM users WHERE id = usage_days.user_id
	)
)
WHERE user_id <> (
	SELECT MIN(id) FROM users
	WHERE lower(github_login) = (
		SELECT lower(github_login) FROM users WHERE id = usage_days.user_id
	)
);

UPDATE machines
SET user_id = (
	SELECT MIN(id) FROM users
	WHERE lower(github_login) = (
		SELECT lower(github_login) FROM users WHERE id = machines.user_id
	)
)
WHERE user_id <> (
	SELECT MIN(id) FROM users
	WHERE lower(github_login) = (
		SELECT lower(github_login) FROM users WHERE id = machines.user_id
	)
);

UPDATE api_keys
SET user_id = (
	SELECT MIN(id) FROM users
	WHERE lower(github_login) = (
		SELECT lower(github_login) FROM users WHERE id = api_keys.user_id
	)
)
WHERE user_id <> (
	SELECT MIN(id) FROM users
	WHERE lower(github_login) = (
		SELECT lower(github_login) FROM users WHERE id = api_keys.user_id
	)
);

-- the merge can leave the surviving user with a live key per merged row; the
-- newest key wins, as it does on a sign-in. A login that never collided keeps
-- every key it had.
UPDATE api_keys
SET revoked_at = CURRENT_TIMESTAMP
WHERE revoked_at IS NULL
	AND EXISTS (
		SELECT 1 FROM api_keys AS newer
		WHERE newer.user_id = api_keys.user_id
			AND newer.revoked_at IS NULL
			AND newer.rowid > api_keys.rowid
	)
	AND user_id IN (
		SELECT MIN(id) FROM users
		GROUP BY lower(github_login)
		HAVING COUNT(*) > 1
	);

DELETE FROM users
WHERE id <> (
	SELECT MIN(id) FROM users AS canonical
	WHERE lower(canonical.github_login) = lower(users.github_login)
);

UPDATE users SET github_login = lower(github_login);
