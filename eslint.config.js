// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // The last entry is a worktree the Agent tool creates for a subagent working
  // in parallel. It holds a second checkout with its own dist/, and the bare
  // 'dist/' pattern above is anchored at the repository root, so eslint walked
  // into it and reported that checkout's build output as findings in this one.
  // docs/internal/ holds working documents and design handoffs, including
  // vendored JavaScript nobody here wrote. `pnpm run verify` is now the whole
  // contract (issue #71), so anything eslint reads can fail a pull request —
  // and a design artifact dropped in the tree would. The style checker already
  // draws this line: guardrails.yml notes that a document under docs/internal/
  // never gates a pull request. This makes the lint agree with it.
  { ignores: ['dist/', 'node_modules/', '.claude/worktrees/', 'docs/internal/'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
