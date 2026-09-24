// Tests for the fail-closed auth logic in config.mjs. Pure functions over a
// plain env object, so no process.exit()/real environment mutation needed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveApiAuth, isDeployedEnvironment, FatalConfigError } from './config.mjs'

test('isDeployedEnvironment: true when SPACE_ID is set (Hugging Face sets this)', () => {
  assert.equal(isDeployedEnvironment({ SPACE_ID: 'abc' }), true)
})

test('isDeployedEnvironment: true when COWORK_ENV=production', () => {
  assert.equal(isDeployedEnvironment({ COWORK_ENV: 'production' }), true)
})

test('isDeployedEnvironment: false otherwise', () => {
  assert.equal(isDeployedEnvironment({}), false)
  assert.equal(isDeployedEnvironment({ COWORK_ENV: 'development' }), false)
})

test('resolveApiAuth: deployed + no COWORK_API_TOKEN fails closed', () => {
  assert.throws(() => resolveApiAuth({ SPACE_ID: 'abc' }), FatalConfigError)
})

test('resolveApiAuth: deployed + COWORK_API_AUTH_DISABLED=true fails closed', () => {
  assert.throws(
    () =>
      resolveApiAuth({ SPACE_ID: 'abc', COWORK_API_TOKEN: 'x', COWORK_API_AUTH_DISABLED: 'true' }),
    FatalConfigError,
  )
})

test('resolveApiAuth: deployed + COWORK_API_TOKEN set succeeds and is never auto-generated', () => {
  const result = resolveApiAuth({ SPACE_ID: 'abc', COWORK_API_TOKEN: 'secret-token' })
  assert.deepEqual(result, {
    token: 'secret-token',
    disabled: false,
    generated: false,
    deployed: true,
  })
})

test('resolveApiAuth: local dev with COWORK_API_AUTH_DISABLED=true disables auth', () => {
  const result = resolveApiAuth({ COWORK_API_AUTH_DISABLED: 'true' })
  assert.deepEqual(result, { token: null, disabled: true, generated: false, deployed: false })
})

test('resolveApiAuth: local dev with COWORK_API_TOKEN set uses it', () => {
  const result = resolveApiAuth({ COWORK_API_TOKEN: 'dev-token' })
  assert.deepEqual(result, {
    token: 'dev-token',
    disabled: false,
    generated: false,
    deployed: false,
  })
})

test('resolveApiAuth: local dev with nothing set generates a token', () => {
  const result = resolveApiAuth({})
  assert.equal(result.disabled, false)
  assert.equal(result.generated, true)
  assert.equal(result.deployed, false)
  assert.equal(typeof result.token, 'string')
  assert.ok(result.token.length > 0)
})

test('resolveApiAuth: two generated tokens are not the same value', () => {
  const a = resolveApiAuth({})
  const b = resolveApiAuth({})
  assert.notEqual(a.token, b.token)
})
