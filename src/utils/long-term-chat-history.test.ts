import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { LongTermChatHistory } from './long-term-chat-history.js';

describe('LongTermChatHistory PII redaction', () => {
  test('persists sanitized user messages and agent responses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dexter-history-'));
    try {
      const history = new LongTermChatHistory(dir);
      await history.addUserMessage('계좌 110-123-456789 분석해줘');
      await history.updateAgentResponse('알림은 010-1234-5678로 보냈습니다.');

      const [entry] = history.getMessages();
      expect(entry.userMessage).toBe('계좌 [REDACTED_BANK_ACCT] 분석해줘');
      expect(entry.agentResponse).toBe('알림은 [REDACTED_PHONE_KR]로 보냈습니다.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
