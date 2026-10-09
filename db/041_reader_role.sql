-- The role the console's readers and the latency report connect as (DEC-04).
--
-- Each reader runs in one READ ONLY transaction, and READ ONLY refuses a write
-- to a table and nothing else. Under a superuser a read can still end another
-- session, write rows to the catalog, or create a replication slot or origin.
-- The source guards catch a mistake in ordinary code, and nothing stops code
-- written to evade them. This role is the barrier against that code.
--
-- This file creates the role and nothing more. `pnpm run db:migrate` states
-- the rest after every run (src/ledger/reader-role.ts), because this file runs
-- once: the tables the role reads, its attributes, limits and settings, no
-- membership, the rights PUBLIC holds that act beyond a read, and its login.
-- Like that step, this file needs a superuser.
--
-- A role is shared by every database on the server, so a second ledger on the
-- same server finds it present and leaves it.
DO $$
BEGIN
  CREATE ROLE auracle_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;
