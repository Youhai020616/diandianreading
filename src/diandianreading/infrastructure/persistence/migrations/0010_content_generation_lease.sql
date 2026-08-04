-- C1b: make a content asset a recoverable task unit, not only a stored draft.
--
-- C0 froze generated_contents as a content asset. C1b requires the same row to
-- survive a worker crash, an expired lease, a cancellation race and an ambiguous
-- provider outcome, which is what chat_runs already does for chat. Those columns
-- were missing, so they are added here rather than by rewriting 0009: that
-- migration is already applied and checksum-verified, and editing it would break
-- verification on any database that has run it.
--
-- Only additive ALTERs are used, so a rollback drops the columns and leaves the
-- C0 shape intact.

ALTER TABLE generated_contents ADD COLUMN lease_owner TEXT;
ALTER TABLE generated_contents ADD COLUMN lease_expires_at TEXT;
ALTER TABLE generated_contents ADD COLUMN lease_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE generated_contents ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE generated_contents ADD COLUMN cancel_requested_at TEXT;
ALTER TABLE generated_contents ADD COLUMN provider_request_started_at TEXT;
ALTER TABLE generated_contents ADD COLUMN provider_operation_id TEXT;
ALTER TABLE generated_contents ADD COLUMN failure_code TEXT;
ALTER TABLE generated_contents ADD COLUMN completed_at TEXT;

-- SQLite cannot add a CHECK constraint to an existing table, and rebuilding
-- generated_contents would rewrite a table 0009 just created. The lease
-- invariants are therefore enforced by the repository and by partial indexes
-- below, which is what actually prevents two workers from owning one asset.

-- At most one live lease per asset, and a lease only exists while generating.
CREATE UNIQUE INDEX generated_contents_single_lease
    ON generated_contents (id)
    WHERE lease_owner IS NOT NULL;

CREATE INDEX generated_contents_claimable
    ON generated_contents (status, lease_expires_at)
    WHERE status IN ('queued', 'generating');

-- One provider generation per asset: the remote operation identifier is the
-- fingerprint that stops a retry from creating a second remote artefact.
CREATE UNIQUE INDEX generated_contents_provider_operation
    ON generated_contents (provider_operation_id)
    WHERE provider_operation_id IS NOT NULL;
