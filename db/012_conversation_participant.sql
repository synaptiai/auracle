-- Conversation membership is bound to a participant — DEC-35, DEC-17.
--
-- `resolveConversation` joins an inbound message to a conversation on
-- evidence the sender controls: the References and In-Reply-To headers, or
-- the ticket id in a webhook body. Neither is authenticated. Without a
-- participant check, a message that names a victim's Message-ID joins the
-- victim's conversation, and db/010 then persists its text as a turn of that
-- conversation. The later turns of the victim's own thread carry that text
-- into the prompt (DEC-37).
--
-- The address is evidence, not proof: mail sender addresses are forgeable.
-- It removes the join that needs no forgery at all, which is the gap.
--
-- The conversation decides, not the message. Allowing an unnamed sender was a
-- bypass: a From header that does not parse yields a null, so a sender opted
-- out of the check by omitting it.
--
-- A conversation that names nobody is claimed by the first sender that names
-- itself. Otherwise it accepts every sender for ever and becomes a universal
-- absorber for anyone the other conversations on that ticket refuse.
--
-- Forward-only, and safe to re-apply: the test suites re-apply every
-- migration between cases.

ALTER TABLE conversation ADD COLUMN IF NOT EXISTS customer_address text;

COMMENT ON COLUMN conversation.customer_address IS
  'DEC-35: the participant whose messages join this conversation. Set when the conversation opens, or claimed by the first sender that names itself. Null means nobody has named one, and a null here accepts any sender until one claims it. A conversation that names a participant refuses every other sender, including an unnamed one.';

-- Backfill is deliberately absent. A conversation opened before this
-- migration has no recorded participant, and a null here accepts any sender,
-- so existing conversations keep their current behaviour rather than gaining
-- a guess about who owns them.
