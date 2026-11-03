import { describe, expect, it } from 'vitest'
import { chooseVoice, localePrefix, parseSayVoices } from './tts'

const SAY_OUTPUT = `Albert              en_US    # Hello! My name is Albert.
Eddy (English (US)) en_US    # Hello! My name is Eddy.
Samantha            en_US    # Hello! My name is Samantha.
Linh                vi_VN    # Xin chào! Tên tôi là Linh.
Tingting            zh_CN    # 你好！我叫婷婷。
Meijia              zh_TW    # 你好，我叫美佳。
`

describe('parseSayVoices', () => {
  it('reads names, including ones with spaces and parentheses', () => {
    const voices = parseSayVoices(SAY_OUTPUT)
    expect(voices).toHaveLength(6)
    expect(voices[1]).toEqual({ name: 'Eddy (English (US))', locale: 'en_US' })
    expect(voices[3]).toEqual({ name: 'Linh', locale: 'vi_VN' })
  })
})

describe('localePrefix', () => {
  it('maps script subtags to the region voices use', () => {
    expect(localePrefix('zh-Hans')).toBe('zh_cn')
    expect(localePrefix('zh-Hant')).toBe('zh_tw')
    expect(localePrefix('pt-BR')).toBe('pt_br')
    expect(localePrefix('vi')).toBe('vi')
  })
})

describe('chooseVoice', () => {
  const voices = parseSayVoices(SAY_OUTPUT)

  it('matches by language or region', () => {
    expect(chooseVoice(voices, 'vi')?.name).toBe('Linh')
    expect(chooseVoice(voices, 'zh-Hant')?.name).toBe('Meijia')
  })

  it('never picks a novelty voice, and prefers plain names', () => {
    expect(chooseVoice(voices, 'en')?.name).toBe('Samantha')
    expect(chooseVoice(parseSayVoices('Albert  en_US  # x\n'), 'en')).toBeNull()
  })

  it('returns null when no voice speaks the language', () => {
    expect(chooseVoice(voices, 'ko')).toBeNull()
  })
})
