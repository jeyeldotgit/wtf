import { describe, it, expect } from 'vitest';
import { SecretRedactor, redactSecrets } from '../redact-secrets.js';

const REDACTED = '[REDACTED_SECRET]';

describe('redactSecrets (one-shot)', () => {
  it('redacts env-style API key assignments', () => {
    const input = 'export API_KEY=sk-proj-12345secretvalue';
    const result = redactSecrets(input);
    expect(result).toContain(REDACTED);
    expect(result).not.toContain('sk-proj-12345secretvalue');
  });

  it('redacts Bearer tokens', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.payload.signature';
    const result = redactSecrets(input);
    expect(result).toContain(REDACTED);
    expect(result).not.toContain('eyJhbGciOiJSUzI1NiJ9');
  });

  it('redacts credential URLs', () => {
    const input = 'DATABASE_URL=https://admin:p4ssw0rd@db.example.com/prod';
    const result = redactSecrets(input);
    expect(result).toContain(REDACTED);
    expect(result).not.toContain('p4ssw0rd');
  });

  it('redacts PEM private key blocks', () => {
    const input = [
      'some text',
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIBogIBAAJBALRiMLAHudeSA/x3hB2f+2NRkJLA',
      '-----END RSA PRIVATE KEY-----',
      'more text',
    ].join('\n');
    const result = redactSecrets(input);
    expect(result).toContain(REDACTED);
    expect(result).not.toContain('MIIBogIBAAJBALRiMLAHudeSA');
  });

  it('redacts well-known API key prefixes (ghp_)', () => {
    const token = 'ghp_' + 'a'.repeat(40);
    const input = `Token: ${token}`;
    const result = redactSecrets(input);
    expect(result).toContain(REDACTED);
    expect(result).not.toContain(token);
  });

  it('redacts well-known API key prefixes (xoxb-)', () => {
    const token = 'xoxb-' + '1234567890-abcdefghij-more';
    const input = `SLACK_TOKEN=${token}`;
    const result = redactSecrets(input);
    expect(result).toContain(REDACTED);
    expect(result).not.toContain(token);
  });

  it('redacts AWS AKIA access key IDs', () => {
    const input = 'aws_key = AKIAIOSFODNN7EXAMPLE';
    const result = redactSecrets(input);
    expect(result).toContain(REDACTED);
    expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('redacts quoted secret assignments', () => {
    const input = 'token: "super_secret_token_value"';
    const result = redactSecrets(input);
    expect(result).toContain(REDACTED);
    expect(result).not.toContain('super_secret_token_value');
  });

  it('redacts AWS secret key assignments', () => {
    const input = 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const result = redactSecrets(input);
    expect(result).toContain(REDACTED);
    expect(result).not.toContain('wJalrXUtnFEMI');
  });

  it('handles multiple secrets on the same line', () => {
    const input = 'API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz password: "hunter2_extended"';
    const result = redactSecrets(input);
    // Both should be redacted
    expect(result).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(result).not.toContain('hunter2_extended');
  });

  it('passes through non-secret text unmodified', () => {
    const input = 'This is a normal log line with exit code 1.\nAnother line.';
    const result = redactSecrets(input);
    expect(result).toBe(input);
  });
});

describe('SecretRedactor (streaming / chunk-aware)', () => {
  it('handles secrets split across chunk boundaries', () => {
    const redactor = new SecretRedactor();
    // Split a secret across two chunks: "sk-pr" | "oj-12345abcdefghij1234567"
    const chunk1 = 'Some text API_KEY=sk-pr';
    const chunk2 = 'oj-12345abcdefghij1234567 end of line\n';

    const out1 = redactor.feed(chunk1);
    const out2 = redactor.feed(chunk2);
    const out3 = redactor.flush();

    const combined = out1 + out2 + out3;
    expect(combined).toContain(REDACTED);
    expect(combined).not.toContain('sk-proj-12345abcdefghij1234567');
  });

  it('buffers small chunks and flushes correctly', () => {
    const redactor = new SecretRedactor();
    const out1 = redactor.feed('short');
    expect(out1).toBe(''); // Too small to emit

    const out2 = redactor.flush();
    expect(out2).toBe('short');
  });

  it('handles credentials in credential URLs split across chunks', () => {
    const redactor = new SecretRedactor();
    const chunk1 = 'Connecting to https://admin:s3cr';
    const chunk2 = 'et_pass@db.example.com/production\n';

    const out1 = redactor.feed(chunk1);
    const out2 = redactor.feed(chunk2);
    const out3 = redactor.flush();

    const combined = out1 + out2 + out3;
    expect(combined).toContain(REDACTED);
    expect(combined).not.toContain('s3cret_pass');
  });

  it('processes large text efficiently with multiple feeds', () => {
    const redactor = new SecretRedactor();
    const lines = Array.from({ length: 100 }, (_, i) => `Log line ${i}: nothing secret here.\n`);
    const secret = 'API_KEY=sk-proj-thisisasecretkeyvalue1234567890\n';

    // Feed lines one by one, inject secret in the middle
    let result = '';
    for (let i = 0; i < 50; i++) {
      result += redactor.feed(lines[i]);
    }
    result += redactor.feed(secret);
    for (let i = 50; i < 100; i++) {
      result += redactor.feed(lines[i]);
    }
    result += redactor.flush();

    expect(result).toContain(REDACTED);
    expect(result).not.toContain('thisisasecretkeyvalue1234567890');
    // Non-secret lines should pass through
    expect(result).toContain('Log line 0:');
    expect(result).toContain('Log line 99:');
  });
});
