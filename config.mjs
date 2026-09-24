// config.mjs — startup configuration decisions that depend on the deployment
// environment. Kept separate from api.mjs (which only handles requests) and
// pure (an env object in, a decision or a thrown FatalConfigError out) so
// server.mjs's fail-closed behavior is unit-testable without actually
// calling process.exit() in a test run.
import crypto from 'node:crypto'

export class FatalConfigError extends Error {}

// Hugging Face Docker Spaces set SPACE_ID automatically for every running
// Space — there's no separate "prod flag" to configure. Treat its presence
// (or an explicit COWORK_ENV=production, for non-HF deployments) as "this
// is a deployed instance" for the purpose of fail-closed auth below.
export function isDeployedEnvironment(env) {
  return Boolean(env.SPACE_ID) || env.COWORK_ENV === 'production'
}

// Decides the /api/v1 bearer token, or throws FatalConfigError if the
// deployment is misconfigured in a way that must not silently fall back.
//
// Deployed (SPACE_ID set, or COWORK_ENV=production):
//   - COWORK_API_TOKEN must be set. No auto-generated token, ever — a
//     generated token is only as secret as the container logs it's printed
//     to, which is an acceptable trade-off for a throwaway local session
//     but not for a public Space.
//   - COWORK_API_AUTH_DISABLED is refused outright.
//
// Local/dev (neither of the above):
//   - COWORK_API_AUTH_DISABLED=true disables auth entirely.
//   - Otherwise COWORK_API_TOKEN is used if set, else a random token is
//     generated and returned (the caller is expected to log it).
export function resolveApiAuth(env) {
  const deployed = isDeployedEnvironment(env)
  const disabledRequested = env.COWORK_API_AUTH_DISABLED === 'true'

  if (deployed) {
    if (disabledRequested) {
      throw new FatalConfigError(
        'COWORK_API_AUTH_DISABLED=true is not allowed in a deployed environment ' +
          '(SPACE_ID is set, or COWORK_ENV=production is set). Refusing to start.',
      )
    }
    if (!env.COWORK_API_TOKEN) {
      throw new FatalConfigError(
        'COWORK_API_TOKEN must be set in a deployed environment ' +
          '(SPACE_ID is set, or COWORK_ENV=production is set). Set it as a Space secret — ' +
          'refusing to start with an auto-generated token in a public deployment.',
      )
    }
    return { token: env.COWORK_API_TOKEN, disabled: false, generated: false, deployed: true }
  }

  if (disabledRequested) {
    return { token: null, disabled: true, generated: false, deployed: false }
  }

  if (env.COWORK_API_TOKEN) {
    return { token: env.COWORK_API_TOKEN, disabled: false, generated: false, deployed: false }
  }

  return {
    token: crypto.randomBytes(24).toString('base64url'),
    disabled: false,
    generated: true,
    deployed: false,
  }
}
