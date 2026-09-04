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
every box it draws an edge to, that every box has a legend row, and that three
of the four rules in section 1 survive an edit.

The checker decides structure and reference. It does not decide whether a
diagram is true. Only a reader does that.

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
    WH["webhook<br/>signed HTTP"]
    IMAPD["imap<br/>polls unseen mail"]
  end

  ENQ["intake<br/>one message becomes one turn<br/>of one conversation"]
  Q[("intake table<br/>the queue, one partition per consumer")]

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
  end

  PERSON(["A person<br/>reads the parked draft,<br/>then approves or rejects it"])
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
| Q | The queue. A partition is a group of tickets one consumer owns. |
| CONS | The daemon that does the work. One consumer owns each partition. |
| SM | The run coordinator. It walks each ticket through fixed steps. |
| KB | The stored answers the system may cite. |
| LGR | The tables that hold all state. The system writes here before it acts. |
| ESCQ | A read-only report. It lists the runs that need a person, with the reason. |
| OBX | The table that holds actions the relay has yet to send. |
| ADAPT | The components that connect the system to one external system. |
| HD | The reference helpdesk adapter. It holds fixtures and reaches no network. |
| SMTP | The mail adapter. An adopter chooses it, and then real mail leaves. |
| PERSON | A reviewer. For a customer reply they read the draft inside the tool they already use. |
| APPR | The command a reviewer runs to approve one parked action. |
| RELAYD | The daemon that drains the outbox. |
| RL | It sends the action, and only then records that it sent. |

Read the two arrows into the outbox together. A reversible internal write goes
automatically. A customer reply does not, so it waits (DEC-12).

Two kinds of work wait for a person, and they wait in different places. A
customer reply parks as a draft in the adapter, and the reviewer opens it in
the tool they already use (DEC-11). A gated internal write has nothing to park
there, so it parks in the ledger and calls no adapter (DEC-34). The escalations
report is how a person finds that second kind.

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
    CALIBRATE["calibrate<br/>fits the agreement threshold"]
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
    BANDS["bands<br/>the four control-band metrics"]
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
  FITTING -.->|"writes the numbers the<br/>consumer reads at startup"| CONSUMERD
  WATCH -.->|"reads only"| LEDGER
```

| Name | What it means |
|---|---|
| DAEMONS | The four processes that run without stopping. |
| WEBHOOKD | Accepts messages over HTTP. It checks the signature only when an adopter sets a secret. |
| IMAPPOLL | Accepts messages from a mailbox. |
| CONSUMERD | Walks each ticket through the steps. |
| RELAYD2 | Sends the actions the outbox holds. |
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
| FITTING | Jobs that choose or publish a number. None touches live traffic. |
| CALIBRATE | Chooses the threshold the first gate compares against. |
| FITGROUND | Chooses the two thresholds the second gate compares against. |
| REPORTGROUND | Measures those two thresholds on cases that chose nothing. |
| GOLDREPORT | Produces the numbers the README publishes. |
| REPLAY | Replays labelled cases with no network and no database. |
| TRIAGE | Selects cases for review. It never gives a published number. |
| INDUCE | Groups past tickets and proposes a name for each group. |
| WATCH | Reports that read the ledger and write nothing to it. |
| ESCALATIONS | Lists the runs that need a person, with the reason. |
| LATENCY | Reports queue wait and service time for each partition. |
| BANDS | Reports the four control-band metrics for one day. |
| SETUP | Jobs an operator runs before or between runs. |
| MIGRATE | Applies each schema file in order and records the version. |
| LOADDOCS | Reads a directory of documents into the knowledge base. |
| EXPORT | Pulls real threads out of a mailbox. That output never enters the repository. |

The two gates stay apart on purpose (DEC-05). One catches a classifier that
answers inconsistently. The other catches an answer that no source supports. A
single blended score can pass while one of them has failed.

## 3. The stored state

The drawing below shows the tables and how the code joins them. Every line is
broken, and the paragraph under the drawing says why.

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
  CONVERSATION ||..o{ TURN : "holds"
  CONVERSATION ||..o{ INTAKE : "queues"
  CONVERSATION ||..o{ RUN : "owns"
  RUN ||..o{ STEP_JOURNAL : "journals"
  RUN ||..o{ OUTBOX : "queues"
  TICKET_EPOCH ||..o{ RUN : "fences"
```

| Name | What it means |
|---|---|
| CONVERSATION | One thread with one customer. It counts the turns it holds. |
| TURN | One message in a thread, and the reply a person approved for it. |
| INTAKE | The queue. One row waits for a consumer to pick it up. |
| RUN | One pass of the coordinator over one ticket. |
| TICKET_EPOCH | The highest fencing epoch a ticket accepts. It stops a stale writer. |
| STEP_JOURNAL | One row for each step. The system writes here before it acts. |
| OUTBOX | One row for each action the relay has yet to send. |
| DOCUMENT | The knowledge base. It joins nothing else, by design. |
| SCHEMA_VERSION | Each migration the runner applied. `src/ledger/migrate.ts` creates this one. |

**The database declares no foreign key.** All fourteen schema files declare
none, and `SCHEMA_VERSION` is not among them because the migration runner
creates it. So every line above is a join the application makes and the database does
not enforce. A broken line says so. Delete a conversation row and no row
disappears with it.

`DOCUMENT` stands alone. The retriever searches it by words and by meaning, and
no ledger row points at it.

Read `TICKET_EPOCH` beside `RUN`. The epoch is a number that increases, and it
makes a write from an old owner fail rather than corrupt the state.

## Where to go next

- [The decision register](v1-architecture.md) holds the decisions. It is the only design authority.
- [The runbook](operations.md) tells an operator what to run.
- [The V2 roadmap](v2-roadmap.md) says what is left and what blocks it.
- [The contributing guide](../CONTRIBUTING.md) takes you from a checkout to a merged change.
- [The README](../README.md) states the published numbers and the compliance position.
