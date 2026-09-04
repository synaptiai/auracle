// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // The last entry is a worktree the Agent tool creates for a subagent working
  // in parallel. It holds a second checkout with its own dist/, and the bare
  // 'dist/' pattern above is anchored at the repository root, so eslint walked
  // into it and reported that checkout's build output as findings in this one.
  { ignores: ['dist/', 'node_modules/', '.claude/worktrees/'] },
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
