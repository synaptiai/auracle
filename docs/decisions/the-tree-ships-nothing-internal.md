# The tree ships nothing internal, private or obsolete

## Problem

The repository becomes public. On main, its tree holds material that serves no
outside reader. Two prompts that set up the agent tooling and a note between
agent sessions sit in the tree. The canvas guide links a private page. Twelve
design documents have generated identifiers as file names.

The release workflow deploys the image to the owner's development host over
SSH. A public workflow that reaches one person's host is of no use to an
adopter. It also names that host's settings.

## Proposed outcome

The internal prompts and the session note leave the tree. The playbook stays
as background, and it says the register supersedes it. Each design document
has a name that says what it is, and the register's table names every one.

The release workflow builds the image and checks that it names its processes.
Only then does it push the image, tagged with the commit SHA. It deploys
nowhere. The runbook gives the steps to run that image on your own host. Those
steps set each secret, check that each one is set, and confirm that each
process runs.

A test reads the workflow and pins its triggers, its jobs, their permissions
and the order of the steps. It also fails when the workflow names SSH, SCP,
curl, wget, a Docker host, a `DEV_` setting or a deploy.

## Affected users and systems

An adopter who runs the image. They pull a tag whose image passes its check,
into their own stack. The owner, whose development deploy moves to a private
repository. A reader of the design documents, who finds each one by a name.

## Constraints

- DEC-17 makes the deployment and its data the adopter's to choose. The
  repository publishes an image and deploys it nowhere.
- DEC-19 requires the documentation to state the compliance position. The
  runbook names each secret a host must set, and the default each one replaces.

## Decisions affected

Affects: DEC-17, DEC-19

DEC-17 holds: the workflow publishes an image, and the adopter runs it. No
step reaches a host. DEC-19 holds: the runbook states what a host must set
before the stack holds customer data.

The register's table changes file names only. The decisions its rows record
are unchanged.

Neither decision changes.

## Open questions

None.
