import type { Context } from 'hono'
import { HTTPError } from './storage'

/** Size limits are installed before routes; JSON endpoints require an object. */
export async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  let body: unknown
  try { body = await c.req.json() }
  catch { throw new HTTPError(400, 'invalid JSON body') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HTTPError(400, 'JSON body must be an object')
  return body as Record<string, unknown>
}
