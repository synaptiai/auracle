-- A record the relay escalated because it never reached the customer
-- (DEC-30, issue #159).
--
-- DEC-30 escalates a send whose delivery state is unknown, as
-- delivery_unknown. An adapter can prove that an attempt sent nothing. When a
-- retry can clear the fault, the relay leaves the record pending for the next
-- scan. When no retry can, and no attempt can ever have reached the customer,
-- it escalates the record as not_sent: a draft with nobody to send to, or a
-- draft id or key no retry can change. A refusal from the mail server proves
-- nothing about an earlier attempt, because someone may have sent the draft
-- first, so a refused login or a draft that is gone stays delivery_unknown.
--
-- Like malformed, not_sent says the relay sent nothing, so the turn stays open
-- to a new attempt. Unlike malformed, the payload was sound: the fault was in
-- the target system.
ALTER TABLE outbox DROP CONSTRAINT IF EXISTS outbox_status_check;
ALTER TABLE outbox ADD CONSTRAINT outbox_status_check
  CHECK (status IN ('pending', 'sent', 'fenced', 'delivery_unknown', 'malformed', 'not_sent'));

COMMENT ON COLUMN outbox.status IS 'Relay scan state, one of pending, sent, fenced, delivery_unknown, malformed, not_sent. The relay reads pending, and skips a pending row whose not_before is ahead (DEC-51); the escalations query reads delivery_unknown, malformed and not_sent.';
