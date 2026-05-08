import { describe, expect, test } from 'bun:test';
import { Scratchpad } from './scratchpad.js';

describe('Scratchpad PII redaction', () => {
  test('stores sanitized query, args, and tool results', () => {
    const scratchpad = new Scratchpad('내 휴대폰 010-1234-5678로 분석해줘');
    scratchpad.addToolResult(
      'test_tool',
      { query: '계좌 110-123-456789 조회' },
      '주민번호 901231-1234567 결과',
    );

    const records = scratchpad.getToolCallRecords();
    const serialized = JSON.stringify(records);

    expect(serialized).not.toContain('010-1234-5678');
    expect(serialized).not.toContain('110-123-456789');
    expect(serialized).not.toContain('901231-1234567');
    expect(serialized).toContain('[REDACTED_BANK_ACCT]');
    expect(serialized).toContain('[REDACTED_RRN]');
  });
});
