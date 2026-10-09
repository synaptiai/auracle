/**
 * The role every bounded read runs as. Migration 041 creates it, and
 * src/ledger/reader-role.ts restates it on every migration.
 *
 * A module of its own, so the migrator can name the role without importing
 * the shared read, which would make it a reader the read guards then hold.
 */
export const READER_ROLE = 'auracle_reader';
