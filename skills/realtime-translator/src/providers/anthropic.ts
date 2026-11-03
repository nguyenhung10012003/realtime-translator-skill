import Anthropic from '@anthropic-ai/sdk'
import { ProviderAuthError } from './http'

/** Models that accept `fallbacks: "default"`, which reroutes a safety decline. */
const FALLBACK_MODELS = /^claude-(opus-5|fable-5|sonnet-5-5)/
/** Models that accept `output_config.effort`. */
const EFFORT_MODELS = /^claude-(opus-5|fable-5|sonnet-5|haiku-5)/

/** Returns a function completing one prompt on `model` through the official SDK. */
export function createAnthropicCompletion(
  model: string,
): (system: string, user: string) => Promise<string> {
  const client = new Anthropic({ maxRetries: 3 })

  return async (system, user) => {
    const params = {
      model,
      max_tokens: 16_000,
      system,
      messages: [{ role: 'user', content: user }],
      // Translation is routine work and live mode is latency-sensitive.
      ...(EFFORT_MODELS.test(model) ? { output_config: { effort: 'low' } } : {}),
      ...(FALLBACK_MODELS.test(model)
        ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }
        : {}),
    } as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming

    let response: Anthropic.Beta.BetaMessage
    try {
      response = await client.beta.messages.create(params)
    } catch (error) {
      if (
        error instanceof Anthropic.AuthenticationError ||
        error instanceof Anthropic.PermissionDeniedError
      ) {
        throw new ProviderAuthError(`anthropic rejected the credentials: ${error.message}`)
      }
      if (error instanceof Anthropic.APIError) {
        throw new Error(`anthropic returned ${error.status ?? 'an error'}: ${error.message}`)
      }
      if (error instanceof Anthropic.AnthropicError) {
        // Raised before any request when no credential source resolves.
        throw new ProviderAuthError(
          `anthropic needs credentials. Ask the user to set ANTHROPIC_API_KEY. (${error.message})`,
        )
      }
      throw error
    }

    if (response.stop_reason === 'refusal') {
      throw new Error('anthropic declined this text.')
    }
    if (response.stop_reason === 'max_tokens') {
      throw new Error('anthropic ran out of output tokens; use a smaller --batch.')
    }
    return response.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('')
      .trim()
  }
}
