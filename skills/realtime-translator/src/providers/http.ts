import { MissingDependencyError } from '../stt/whisper'

/** The provider refused the credentials, or there are none: retrying can't help. */
export class ProviderAuthError extends MissingDependencyError {}

const MAX_ATTEMPTS = 4
const TIMEOUT_MS = 120_000
const MAX_DELAY_MS = 20_000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A response's error text, shortened. Provider errors never echo request headers. */
async function errorText(response: Response): Promise<string> {
  const body = await response.text().catch(() => '')
  return body.replace(/\s+/g, ' ').slice(0, 500).trim()
}

/** Gemini reports a bad key as 400 API_KEY_INVALID, not 401. */
const isAuthFailure = (status: number, text: string): boolean =>
  status === 401 || (status === 400 && text.includes('API_KEY_INVALID'))

/** The key is fine but can't use this: a valid project without access to a model, say. */
const isAccessFailure = (status: number, text: string): boolean =>
  status === 403 || text.includes('model_not_found')

/**
 * POSTs with a timeout, retrying rate limits, server errors, and network failures with
 * backoff. `send` runs per attempt so a body such as FormData is rebuilt each time.
 */
export async function postWithRetry(
  provider: string,
  url: string,
  init: () => RequestInit,
): Promise<Response> {
  let lastError = ''
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let retryAfterMs: number | null = null
    try {
      const response = await fetch(url, {
        ...init(),
        method: 'POST',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (response.ok) return response

      const text = await errorText(response)
      if (isAuthFailure(response.status, text)) {
        throw new ProviderAuthError(`${provider} rejected the credentials: ${text}`)
      }
      if (isAccessFailure(response.status, text)) {
        throw new ProviderAuthError(
          `${provider} refused access; the key may not include this model. Try another with the matching --*-model flag. ${text}`,
        )
      }
      if (response.status !== 429 && response.status < 500) {
        throw new Error(`${provider} returned ${response.status}: ${text}`)
      }
      lastError = `${response.status}: ${text}`
      const header = Number(response.headers.get('retry-after'))
      if (Number.isFinite(header) && header > 0) retryAfterMs = header * 1000
    } catch (error) {
      // Only network and timeout failures retry; decisions made above surface as they are.
      if (!(error instanceof TypeError) && (error as Error).name !== 'TimeoutError') throw error
      lastError = (error as Error).message
    }
    if (attempt < MAX_ATTEMPTS) {
      await sleep(Math.min(retryAfterMs ?? 500 * 2 ** (attempt - 1), MAX_DELAY_MS))
    }
  }
  throw new Error(`${provider} failed after ${MAX_ATTEMPTS} attempts: ${lastError}`)
}

export async function postJson<T>(
  provider: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<T> {
  const response = await postWithRetry(provider, url, () => ({
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }))
  return (await response.json()) as T
}
