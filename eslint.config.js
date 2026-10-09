// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // The last entry is a worktree the Agent tool creates for a subagent working
  // in parallel. It holds a second checkout with its own dist/, and the bare
  // 'dist/' pattern above is anchored at the repository root, so eslint walked
  // into it and reported that checkout's build output as findings in this one.
  // docs/internal/ is a local directory for working notes that git ignores.
  // Anything eslint reads can fail `pnpm run verify`, and a file dropped there
  // is no part of the tree.
  // A bare pattern matches at the root only, so 'dist/' left console/dist/ in
  // the lint: 46 compiled files. '.decisions/' holds the decision journal and
  // its scratch scripts, which git ignores as well.
  {
    ignores: ['**/dist/', 'node_modules/', '.claude/worktrees/', 'docs/internal/', '.decisions/'],
  },
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
