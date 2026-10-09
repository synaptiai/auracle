// Loading a package a pruned install does not have.
//
// `testcontainers` and `@testcontainers/postgresql` are development
// dependencies that 95 packages hang off — measured, and nothing else in this
// tree reaches any of them. A run that names DATABASE_URL and MAIL_HOST needs
// none of them, and `docker compose --profile test up -d` starts both servers
// those variables point at.
//
// They stay development dependencies. `optionalDependencies` was tried and
// reverted, and both halves of that trade failed:
//
//   - It puts them in the production graph. `pnpm install --prod` installs
//     them, and `Dockerfile`'s runtime stage runs exactly that, so the image
//     pushed to GHCR carried a Docker client and an SSH library under a
//     comment promising no testcontainers. 41 packages became 197.
//   - The saving it was for does not exist. `pnpm install --no-optional`
//     drops testcontainers and also drops rollup's own platform-native
//     package, so every vitest project dies before collection with
//     "Cannot find module @rollup/rollup-darwin-arm64". A lean install that
//     cannot run a test is not a lean install.
//
// `pnpm install --prod` excludes them, which is the prune that matters: it is
// what ships.
//
// The load stays dynamic regardless. The specifier is resolved when the
// importing module loads, so a static import fails the `db` and `mail`
// projects at import time with a resolution error and no way out stated —
// whoever pruned, and however.
//
// This module imports nothing, so a pure suite can drive it. It held the
// refusal inside `containers.ts` first, and that made its own suite a
// `.db.test.ts` that needed no database — which `purity.test.ts` refuses,
// correctly.

/**
 * Loads an optional module, or refuses with a message naming both ways out.
 *
 * `specifier` is the package, for a reader who has to install it.
 * `variable` is the environment variable that avoids needing it at all.
 *
 * The loader is passed rather than built from the specifier, because a
 * bundler reads a literal `import()` and cannot follow a computed one.
 */
export async function loadOptional<T>(
  specifier: string,
  load: () => Promise<T>,
  variable: string,
): Promise<T> {
  try {
    return await load();
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    throw new Error(
      `this run needs a throwaway container, and '${specifier}' is not installed. `
        + `Either set ${variable} at a server this run can reach — `
        + '`docker compose --profile test up -d` starts both — or install '
        + 'the optional '
        + `dependencies with \`pnpm install\`. The load said: ${said}`,
    );
  }
}
