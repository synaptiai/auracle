-- The agent's half of a conversation — docs/v1-architecture.md DEC-37.
--
-- db/010 gave a turn the customer's message. History was still half a
-- conversation: the prompts of turn N saw what the customer wrote and never
-- what the system answered. A threshold fitted on that prompt would be fitted
-- on a conversation that reads as a monologue.
--
-- The text is the reply the approval dispatched, which is the body a person
-- approved (DEC-12). It is recorded in the approval transaction, so it
-- commits with the state change or not at all.
--
-- Limit, on purpose: a dispatched reply is not a delivered one. The relay
-- sends afterwards, and a delivery that fails or ends unknown escalates the
-- run (DEC-30). This column is not retracted when that happens, so it reads
-- as "what the approval sent", never as "what the customer received".
--
-- A ledger-only park writes nothing here. DEC-34 compensation is an internal
-- write with no customer-visible text, and putting one into a prompt would
-- show the customer's history an action they never saw.
--
-- Forward-only, and safe to re-apply: the test suites re-apply every
-- migration between cases.

ALTER TABLE turn ADD COLUMN IF NOT EXISTS approved_reply_text text;

COMMENT ON COLUMN turn.approved_reply_text IS 'DEC-37: the reply the approval dispatched for this turn, for the prompts of later turns. Null until a person approves one, and on a turn that never produced a customer reply.';
