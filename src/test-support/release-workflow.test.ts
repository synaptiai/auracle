// The release workflow builds the image, checks it, and only then publishes
// it. It deploys nowhere: an adopter pulls the image into their own stack
// (DEC-17, DEC-19).
//
// No pull request runs this workflow, because it runs on `main` alone. So
// this suite reads the file itself, parses it as YAML, and pins its shape:
// the triggers, the jobs, their permissions and the image job's steps in
// order. A step this suite does not name fails it. So does a condition or a
// `continue-on-error` that lets a failed check reach the push.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const WORKFLOW = fileURLToPath(new URL('../../.github/workflows/release.yml', import.meta.url));

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: unknown;
  with?: Record<string, unknown>;
  'continue-on-error'?: unknown;
}
interface Job {
  if?: string;
  permissions?: unknown;
  concurrency?: unknown;
  'continue-on-error'?: unknown;
  steps?: Step[];
}

const workflow = parse(readFileSync(WORKFLOW, 'utf8')) as { on: unknown; env: Record<string, string>; jobs: Record<string, Job> };

/** The commit a run builds: the one Tests ran on. */
const COMMIT = '${{ github.event.workflow_run.head_sha }}';
const image = workflow.jobs.image!;
const steps = image.steps ?? [];

/** What a step is: its name, or the action it uses without the pin, or its id. */
const identity = (step: Step): string => step.name ?? step.uses?.replace(/@.*/, '') ?? step.id ?? '?';

/** Every string a value holds, keys included, at any depth. */
function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, held]) => [key, ...stringsOf(held)]);
  }
  return [];
}

describe('the release workflow', () => {
  // An image of a commit whose tests failed never reaches the registry: the
  // build starts only after Tests passes on that commit.
  // No dispatch: a build by hand would skip the gate. A re-run of a release
  // reads the same Tests result, so a red Tests run is retried by re-running
  // Tests, which starts a new release.
  it('runs after Tests completes on main, and nothing else', () => {
    expect(workflow.on).toEqual({
      workflow_run: { workflows: ['Tests'], types: ['completed'], branches: ['main'] },
    });
  });

  // A commit whose tests did not pass gets no job at all. Its own red Tests
  // run marks it: a job here would attach its check to the newest commit on
  // main, which a workflow_run event names, and not to the commit tested.
  it('builds only a commit pushed to main whose tests passed', () => {
    expect(Object.keys(workflow.jobs)).toEqual(['image']);
    expect(image.if).toBe(
      "github.event.workflow_run.event == 'push' && github.event.workflow_run.conclusion == 'success'",
    );
    expect(image.permissions).toEqual({ contents: 'read', packages: 'write' });
  });

  it('builds the image without publishing it, checks it, and publishes it last', () => {
    expect(steps.map(identity)).toEqual([
      'actions/checkout',
      'meta',
      'docker/setup-buildx-action',
      'docker/login-action',
      'docker/build-push-action',
      'The image names its processes',
      'Publish the image',
    ]);
    const build = steps[4]!;
    expect(build.with?.push).toBe(false);
    expect(build.with?.load).toBe(true);
    // One push in the whole job, and it is the last step.
    const pushes = steps.flatMap((step, at) => ((step.run ?? '').match(/\bpush\b/g) ?? []).map(() => at));
    expect(pushes).toEqual([steps.length - 1]);
  });

  it('stops the push when the check fails', () => {
    // No condition and no `continue-on-error` lets a step past a failure.
    expect(image['continue-on-error']).toBeUndefined();
    const lenient = steps
      .filter((step) => step.if !== undefined || step['continue-on-error'] !== undefined)
      .map(identity);
    expect(lenient).toEqual([]);
    // The check runs the image it just built, twice: once for the processes
    // it names, and once for the files they run, which it reads from the
    // entrypoint. It exits non-zero on either, and runs no other Docker
    // command.
    const run = steps[5]!.run ?? '';
    expect(run).toMatch(/^set -eu$/m);
    expect(run.match(/\bdocker\s+\w+/g)).toEqual(['docker run', 'docker run']);
    expect(run.match(/docker run --rm (?:--entrypoint sh )?"\$\{\{ steps\.meta\.outputs\.tag \}\}"/g)).toHaveLength(2);
    expect(run).toMatch(/grep -o "\/app\/\[\^ \]\*\\\.js" \/usr\/local\/bin\/entrypoint\.sh/);
    expect(run).toMatch(/\[ -f "\$file" \] \|\| \{ echo "the image lacks \$file" >&2; exit 1; \}/);
    expect(run).toMatch(/ls \/app\/db\/\*\.sql >\/dev\/null 2>&1 \|\| \{ echo "the image lacks the migrations in \/app\/db" >&2; exit 1; \}/);
    expect(run.match(/exit 1/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('builds and tags the commit the tests ran on, by its SHA alone', () => {
    expect(workflow.env.COMMIT).toBe(COMMIT);
    expect(steps[0]!.with?.ref).toBe(COMMIT);
    expect(steps[1]!.run).toBe('echo "tag=${REGISTRY}/${IMAGE}:${COMMIT}" >> "$GITHUB_OUTPUT"');
    // `ubuntu-latest` names a runner, not a tag.
    expect(stringsOf(workflow).filter((text) => /(?<!ubuntu-)\blatest\b/.test(text))).toEqual([]);
  });

  it('builds every commit on main in a group of its own, so a newer one cancels none', () => {
    expect(image.concurrency).toEqual({ group: `image-${COMMIT}`, 'cancel-in-progress': false });
  });

  it('names no host, remote shell or deploy', () => {
    const named = stringsOf(workflow)
      .filter((text) => /\bssh\b|\bscp\b|\bcurl\b|\bwget\b|DOCKER_HOST|\bDEV_|deploy|known_hosts/i.test(text));
    expect(named).toEqual([]);
  });
});
