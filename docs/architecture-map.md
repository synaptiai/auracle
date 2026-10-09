# Architecture map

This document draws the system. `docs/v1-architecture.md` decides it, and this
map never overrules that register. Read the register for a decision. Read this
map for a picture.

Each diagram has a legend below it. The legend names every box, so a reader who
writes no code can still follow the drawing.

Where the register's appendix names a thing, this map uses that name. One name
has one meaning, so this document introduces no friendlier word for a thing the
register already names.

`scripts/check-docs.py` reads this file. It proves that each diagram declares
every box it draws an edge to. It also proves that every box has a legend
row. And it proves that parts of three rules in section 1 survive an edit.

The checker decides structure and reference. It does not decide whether a
diagram is true. A database test checks the entity diagram against the
migrated ledger, as section 3 says. A reader checks the other two.

## 1. One message, end to end

The drawing below follows one customer message from arrival to reply.

Four parts of it are easy to get wrong:

1. A customer reply that waits for approval queues nothing to send. The draft
   goes to the adapter, and a person acts there.
2. The draft never travels from the coordinator to a person directly.
3. The path back to the customer needs a configuration choice. The map draws
   it with a broken line.
4. A gated internal write parks in the ledger and calls no adapter (DEC-34).
   A person finds it through the escalations report.

The checker holds the second sentence of rule 1, and it holds rules 2 and 3.
It cannot hold the first sentence of rule 1, and it cannot hold rule 4. Both
ask what an edge means, and only a reader decides that.

```mermaid
flowchart TB
  subgraph EXT["Outside the system"]
    CUST["A customer<br/>sends a message"]
    LLM["OpenRouter<br/>the one model provider"]
    MAILBOX["A mailbox<br/>IMAP reads it, SMTP writes it"]
  end

  subgraph INGRESS["Ingress: two daemons take messages in"]
    WH["webhook<br/>HTTP, signed when a secret is set"]
    IMAPD["imap<br/>polls unseen mail"]
  end

  ENQ["intake<br/>one message becomes one turn<br/>of one conversation"]
  Q[("intake table<br/>the queue, one consumer per partition")]

  subgraph CONS["consumer: one daemon owns each partition"]
    SM["The run coordinator<br/>a plain state machine"]
  end

  KB[("document table<br/>the knowledge base")]
  LGR[("run and step_journal<br/>the ledger writes before it acts")]
  OBX[("outbox table<br/>actions the relay has yet to send")]
  ESCQ["escalations<br/>lists what needs a person, and why"]

  subgraph ADAPT["Adapters: the only code that reaches a target system"]
    HD["Helpdesk adapter, the default<br/>reference only: in memory, no network"]
    SMTP["Mail adapter<br/>sends real mail, once configured"]
    FS["FreeScout adapter<br/>posts to a FreeScout instance"]
  end

  PERSON(["A person<br/>reads the parked draft,<br/>then approves it"])
  APPR["approve<br/>the approval command"]

  subgraph RELAYD["relay: one daemon sends"]
    RL["It sends first,<br/>then records the result"]
  end

  CUST -->|"through a helpdesk or<br/>another system that forwards it"| WH
  CUST --> MAILBOX
  MAILBOX --> IMAPD
  WH --> ENQ
  IMAPD --> ENQ
  ENQ --> Q
  Q --> SM
  SM <-.->|"classify, compose,<br/>check the evidence"| LLM
  SM -->|"retrieve"| KB
  SM -->|"every step, before it acts"| LGR
  SM -->|"both gates pass and the<br/>write is reversible: queue it"| OBX
  SM -->|"a customer reply:<br/>park a draft. This writes<br/>no outbox row"| ADAPT
  SM -->|"a gated internal write:<br/>park in the ledger,<br/>call no adapter (DEC-34)"| LGR
  LGR --> ESCQ
  ADAPT --> PERSON
  ESCQ --> PERSON
  PERSON --> APPR
  APPR -->|"on approval only"| OBX
  OBX --> RL
  RL --> ADAPT
  SMTP -.->|"only once an adopter<br/>configures the mail adapter"| MAILBOX
  MAILBOX -.-> CUST

  style HD stroke-dasharray: 5 5
```

| Name | What it means |
|---|---|
| EXT | Everything the system does not run. |
| CUST | The person who writes to support. |
| LLM | The one model provider. Every model call leaves through it. |
| MAILBOX | An email account. The system reads it and can write to it. |
| INGRESS | The two ways a message arrives. |
| WH | A daemon. It accepts an HTTP request from another system. It checks the signature when an adopter sets a secret, and accepts every caller when nobody does. |
| IMAPD | A daemon. It polls the mailbox for unread mail. |
| ENQ | The step that turns one arriving message into one queue row. |
| Q | The queue. A partition is a group of conversations one consumer owns. |
| CONS | The daemon that does the work. One consumer owns each partition. |
| SM | The run coordinator. It walks each run through fixed steps. |
| KB | The stored answers the system may cite. |
| LGR | The tables that hold all state. The system writes here before it acts. |
| ESCQ | A read-only report. It lists the runs that need a person, with the reason. |
| OBX | The table that holds actions the relay has yet to send. |
| ADAPT | The components that connect the system to one external system. |
| HD | The reference helpdesk adapter. It holds fixtures and reaches no network. |
| SMTP | The mail adapter. An adopter chooses it, and then real mail leaves. |
| FS | The FreeScout adapter. An adopter chooses it, and it posts through the FreeScout API. |
| PERSON | A reviewer. For a customer reply they read the draft in the helpdesk or the operator console. |
| APPR | The command a reviewer runs to approve one parked action. |
| RELAYD | The daemon that drains the outbox. |
| RL | It sends the action, and only then records that it sent. |

Read the two arrows into the outbox together. A reversible internal write goes
automatically. A customer reply does not, so it waits (DEC-12).

Two kinds of work wait for a person, and they wait in different places. A
customer reply parks as a draft in the adapter. The reviewer opens it in the
helpdesk or the operator console (DEC-11, DEC-40, DEC-44). A gated internal
write has nothing to park there, so it parks in the ledger and calls no
adapter (DEC-34). The escalations report is how a person finds that second
kind.

The order inside the relay matters. A status written before the send turns a
crash into an action that looks sent and never was.

## 2. What lives in the source tree

The drawing below groups the code by when it runs. That is a reader's first
question, because a daemon and an offline job fail in different ways.

```mermaid
flowchart LR
  subgraph DAEMONS["Always running"]
    WEBHOOKD["webhook"]
    IMAPPOLL["imap"]
    CONSUMERD["consumer"]
    RELAYD2["relay"]
    CONSOLED["console"]
  end

  subgraph RUNTIME["The path one ticket takes"]
    ENQ2["intake<br/>one message becomes one turn"]
    CLASSIFY["classifier<br/>samples the label nine times"]
    RETRIEVE["retriever<br/>fuses word ranks and meaning ranks"]
    COMPOSE["composer<br/>cites a source or abstains"]
    GROUND["groundedness<br/>gate two: does a source<br/>support each claim?"]
    POLICY["policy engine<br/>a pure function, no model, no state"]
    LEDGER["ledger<br/>one transaction per state change"]
    BRIDGE2["approval bridge<br/>parks a draft for a person"]
    ADAPTERS2["adapters<br/>one per target system"]
    MODELS2["models<br/>the one provider, behind a port"]
  end

  subgraph FITTING["Run when you set the numbers"]
    CALIBRATE["calibrate<br/>fits the agreement thresholds,<br/>global and per intent"]
    FITGROUND["fit-groundedness<br/>fits the two coverage thresholds"]
    REPORTGROUND["report-groundedness<br/>measures the fitted pair"]
    GOLDREPORT["gold-report<br/>publishes the headline numbers"]
    REPLAY["replay<br/>scores routing with no network"]
    TRIAGE["triage<br/>picks cases for a person to read"]
    INDUCE["induce<br/>proposes the list of intents"]
  end

  subgraph WATCH["Run to see how the system is doing"]
    ESCALATIONS["escalations<br/>what needs a person now"]
    LATENCY["latency<br/>which partition falls behind"]
    BANDS["bands<br/>the control-band metrics"]
  end

  subgraph SETUP["Run once, or when the inputs change"]
    MIGRATE["db:migrate<br/>applies each schema file in order"]
    LOADDOCS["load-docs<br/>indexes the knowledge base"]
    EXPORT["export-corpus<br/>draws real history out of a mailbox"]
  end

  WEBHOOKD --> ENQ2
  IMAPPOLL --> ENQ2
  CONSUMERD --> RUNTIME
  ENQ2 --> CLASSIFY
  CLASSIFY --> RETRIEVE
  RETRIEVE --> COMPOSE
  COMPOSE --> GROUND
  CLASSIFY -.-> MODELS2
  COMPOSE -.-> MODELS2
  GROUND -.-> MODELS2
  GROUND --> POLICY
  POLICY --> LEDGER
  POLICY --> BRIDGE2
  BRIDGE2 --> ADAPTERS2
  RELAYD2 --> ADAPTERS2
  CONSOLED -->|"approves through<br/>the approve path"| LEDGER
  CALIBRATE -.->|"writes the numbers the<br/>consumer reads at startup"| CONSUMERD
  FITGROUND -.-> CONSUMERD
  WATCH -.->|"reads only"| LEDGER
```

| Name | What it means |
|---|---|
| DAEMONS | The processes that run without stopping. |
| WEBHOOKD | Accepts messages over HTTP. It checks the signature only when an adopter sets a secret. |
| IMAPPOLL | Accepts messages from a mailbox. |
| CONSUMERD | Walks each run through the steps. |
| RELAYD2 | Sends the actions the outbox holds. |
| CONSOLED | Serves the operator console, where a reviewer approves, closes, sends back or snoozes a parked action. It approves through the same path as the approve command. |
| RUNTIME | The components that handle one ticket. The consumer calls all but the first. |
| ENQ2 | Turns one arriving message into one queue row, and routes it to its conversation. |
| CLASSIFY | Picks the intent. It samples nine times, so disagreement is visible. |
| RETRIEVE | Finds the stored text that could answer the ticket. |
| COMPOSE | Writes the answer with citations, or says it cannot. |
| GROUND | Tests each claim against the retrieved text. This is the second gate. |
| POLICY | Applies the gates and the risk tier of the intent. It calls no model. |
| LEDGER | The Postgres tables that hold all state. It calls no adapter. |
| BRIDGE2 | Puts a customer reply in front of a person as a draft. It calls the adapter. |
| ADAPTERS2 | The code that talks to a helpdesk or a mail server. The drawing shows two callers. The approve command and the imap daemon call it too. |
| MODELS2 | The model port, and the one provider behind it. |
| FITTING | Offline jobs that fit, measure or select. None touches live traffic. |
| CALIBRATE | Chooses the thresholds the first gate compares against: one global, and one for each intent with enough cases. |
| FITGROUND | Chooses the two thresholds the second gate compares against. |
| REPORTGROUND | Measures those two thresholds on cases that chose nothing. |
| GOLDREPORT | Produces the numbers the README publishes. |
| REPLAY | Replays labeled cases with no network and no database. |
| TRIAGE | Selects cases for review. It never gives a published number. |
| INDUCE | Groups past tickets and proposes a name for each group. |
| WATCH | Reports that read the ledger and write nothing to it. |
| ESCALATIONS | Lists the runs that need a person, with the reason. |
| LATENCY | Reports queue wait and service time for each partition. |
| BANDS | Reports the control-band metrics for one day. |
| SETUP | Jobs an operator runs before or between runs. |
| MIGRATE | Applies each schema file in order and records the version. |
| LOADDOCS | Reads a directory of documents into the knowledge base. |
| EXPORT | Pulls real conversations out of a mailbox. That output never enters the repository. |

The two gates stay apart on purpose (DEC-05). One catches a classifier that
answers inconsistently. The other catches an answer that no source supports. A
single blended score can pass while one of them has failed.

## 3. The stored state

The drawing below shows every table and how they join. A solid line is a
foreign key, and a broken line is a join only the code makes. The paragraph
under the drawing names the foreign keys.

```mermaid
erDiagram
  CONVERSATION {
    uuid conversation_id
    int turn_counter
    text customer_address
  }
  TURN {
    int turn_number
    text body_text
    text approved_reply_text
  }
  INTAKE {
    text ticket_id
    text message_id
    int attempts
  }
  RUN {
    uuid run_id
    text state
    bigint epoch
    double_precision approval_edit_distance
  }
  TICKET_EPOCH {
    text ticket_id
    bigint epoch
  }
  STEP_JOURNAL {
    text step_id
    jsonb result
  }
  OUTBOX {
    text idem_key
    text status
    jsonb payload
  }
  DOCUMENT {
    text doc_id
    vector embedding
  }
  SCHEMA_VERSION {
    int version
  }
  REVIEWER {
    text identity
    boolean active
  }
  CASE_HOLD {
    uuid run_id
    text reviewer
    timestamptz lapses_at
  }
  CASE_HOLD_EVENT {
    bigint event_id
    uuid run_id
    text kind
  }
  DOCUMENT_RERUN {
    text doc_id
    uuid run_id
    text status
  }
  GATE_LATEST {
    text product
    text intent_id
    uuid run_id
  }
  CONVERSATION ||..o{ TURN : "holds"
  CONVERSATION ||..o{ INTAKE : "queues"
  CONVERSATION ||..o{ RUN : "owns"
  TURN ||..o{ INTAKE : "arrives as"
  TURN ||..o{ RUN : "is answered by"
  TURN ||..o{ DOCUMENT_RERUN : "is asked again by"
  RUN ||..o{ STEP_JOURNAL : "journals"
  RUN ||..o{ OUTBOX : "queues"
  TICKET_EPOCH ||..o{ RUN : "fences"
  RUN ||..o| CASE_HOLD : "is taken by"
  RUN ||..o{ CASE_HOLD_EVENT : "records"
  REVIEWER ||..o{ CASE_HOLD : "takes"
  DOCUMENT ||--o| DOCUMENT_RERUN : "asks again"
  RUN ||--o{ DOCUMENT_RERUN : "starts"
  RUN ||..o{ GATE_LATEST : "is the latest gate of"
```

| Name | What it means |
|---|---|
| CONVERSATION | One exchange with one customer. It counts the turns it holds. |
| TURN | One message in a conversation, and the reply a person approves for it. |
| INTAKE | The queue. One row waits for a consumer to pick it up. |
| RUN | One pass of the coordinator over one turn, or over a ticket that has no conversation. |
| TICKET_EPOCH | The highest fencing epoch a ticket accepts. It stops a stale writer. |
| STEP_JOURNAL | One row for each step. The system writes here before it acts. |
| OUTBOX | One row for each action the relay has yet to send. |
| DOCUMENT | The knowledge base. The retriever searches it by words and by meaning. |
| SCHEMA_VERSION | Each migration the runner applies. `src/ledger/migrate.ts` creates this one. |
| REVIEWER | The roster of people the console serves. |
| CASE_HOLD | The reviewer who holds the reservation of a parked run now, and when the reservation lapses. |
| CASE_HOLD_EVENT | Each take, handover, release, send, close, send-back and lapse of a reservation. |
| DOCUMENT_RERUN | A document a reviewer writes from a case, and the new attempt it asks for. |
| GATE_LATEST | The most recent gate reading for each product and intent. |

**The solid lines are foreign keys.** A solid line is one the database enforces.
`DOCUMENT_RERUN` declares a foreign key to `DOCUMENT` and one to `RUN`. Every
other table declares no foreign key. So every broken line is a join the
application makes and the database does not enforce. Delete a conversation
row and no row disappears with it.

`src/db/architecture-map.db.test.ts` compares this drawing with the migrated
ledger. A table the drawing leaves out, or a foreign key it draws as a broken
line, fails the test.

Read `TICKET_EPOCH` beside `RUN`. The epoch is a number that increases. It
makes a write from an old owner fail rather than corrupt the state.

## Where to go next

- [The decision register](v1-architecture.md) holds the decisions. It is the only design authority.
- [The runbook](operations.md) tells an operator what to run.
- [The V2 roadmap](v2-roadmap.md) says what is left and what blocks it.
- [The contributing guide](../CONTRIBUTING.md) takes you from a checkout to a merged change.
- [The README](../README.md) states the published numbers and the compliance position.
