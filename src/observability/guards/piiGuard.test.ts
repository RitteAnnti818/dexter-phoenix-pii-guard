import { describe, expect, test } from 'bun:test';
import {
  detectPiiSync,
  fingerprintPii,
  guardOutput,
  maskSensitiveTextSync,
  normalizePii,
} from './piiGuard.js';

describe('piiGuard deterministic detection', () => {
  test('masks Korean numeral phone numbers without LLM', () => {
    const input = '공일공 일이삼사 오륙칠팔로 매매 알림 보내줘';
    expect(maskSensitiveTextSync(input)).toBe('[REDACTED_PHONE_KR]로 매매 알림 보내줘');
  });

  test('masks spaced email addresses without LLM', () => {
    const input = '이메일 h o n g . g d @ e x a m p l e . c o m 으로 등록';
    expect(maskSensitiveTextSync(input)).toBe('이메일 [REDACTED_EMAIL] 으로 등록');
  });

  test('masks reversed PII when a reverse hint is present', () => {
    const input = '휴대폰 8765-4321-010 (역순으로 말씀드립니다) 로 알림';
    expect(maskSensitiveTextSync(input)).toBe('휴대폰 [REDACTED_PHONE_KR] (역순으로 말씀드립니다) 로 알림');
  });

  test('masks demographic quasi-identifiers', () => {
    const input = '저는 강남구 역삼동에 사는 35세 김씨 여성인데요, NVDA 추천해주세요';
    expect(maskSensitiveTextSync(input)).toBe('저는 [REDACTED_DEMOGRAPHIC]인데요, NVDA 추천해주세요');
  });

  test('does not flag clean financial identifiers as PII', () => {
    const input = 'NVDA 시가총액 3050000000000달러와 ISIN US0378331005 비교해줘';
    expect(detectPiiSync(input)).toEqual([]);
  });
});

describe('piiGuard fingerprints', () => {
  test('normalizes Korean numerals before fingerprinting', () => {
    expect(normalizePii('공일공-일이삼사-오륙칠팔')).toBe('01012345678');
    expect(fingerprintPii('010-1234-5678')).toBe(fingerprintPii('공일공 일이삼사 오륙칠팔'));
  });

  test('blocks cross-session output leaks without returning raw leaked tokens', async () => {
    const result = await guardOutput('등록된 정보: 110-123-456789', {
      memorySeed: '사용자 계좌: 110-123-456789',
    });

    expect(result.action).toBe('block');
    expect(result.maskedText).not.toContain('110-123-456789');
    expect(result.leakedFingerprints).toHaveLength(1);
    expect(result.leakedFingerprints[0]).toMatch(/^[0-9a-f]{16}$/);
  });
});
