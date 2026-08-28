/**
 * AI Compose — Thread Truncation Tests
 *
 * Verifies truncateHtmlThread keeps the newest N messages across the common
 * quoted-thread HTML structures produced by different email clients.
 */

import { truncateHtmlThread, splitThreadHtmlMessages } from './thread-truncate';

describe('truncateHtmlThread', () => {
  it('returns empty/blank input unchanged', () => {
    expect(truncateHtmlThread('')).toBe('');
    expect(truncateHtmlThread('<p></p>')).toBe('<p></p>');
  });

  it('returns plain single-message HTML unchanged', () => {
    const html = '<html><body><p>Just a simple message.</p></body></html>';
    expect(truncateHtmlThread(html)).toBe(html);
  });

  describe('nested <blockquote> threads', () => {
    const thread = (levels: number): string => {
      let inner = `<p>Reply ${levels + 1} body (oldest).</p>`;
      for (let i = levels; i >= 1; i--) {
        inner = `<blockquote><p>Reply ${i} body.</p>${inner}</blockquote>`;
      }
      return `<html><body><p>Current reply body text.</p>${inner}</body></html>`;
    };

    it('keeps the newest 3 messages and drops older history', () => {
      const result = truncateHtmlThread(thread(4), 3);
      expect(result).toContain('Current reply body text.');
      expect(result).toContain('Reply 1 body.');
      expect(result).toContain('Reply 2 body.');
      expect(result).not.toContain('Reply 3 body.');
      expect(result).not.toContain('Reply 4 body.');
    });

    it('keeps only the current email when keepReplies is 1', () => {
      const result = truncateHtmlThread(thread(4), 1);
      expect(result).toContain('Current reply body text.');
      expect(result).not.toContain('Reply 1 body.');
      expect(result).not.toContain('Reply 2 body.');
    });

    it('preserves a forwarded email wrapped in a single blockquote', () => {
      const forward =
        '<html><body><p>Current note.</p><blockquote><p>Forwarded content that is the message itself.</p></blockquote></body></html>';
      const result = truncateHtmlThread(forward, 3);
      expect(result).toContain('Current note.');
      expect(result).toContain('Forwarded content that is the message itself.');
    });

    it('keeps everything when there are fewer replies than keepReplies', () => {
      const result = truncateHtmlThread(thread(2), 3);
      expect(result).toContain('Current reply body text.');
      expect(result).toContain('Reply 1 body.');
      expect(result).toContain('Reply 2 body.');
    });

    it('unwraps kept blockquotes to <div> so text conversion keeps their content', () => {
      const result = truncateHtmlThread(thread(2), 3);
      expect(result).not.toContain('<blockquote');
      expect(result).toContain('<div>');
      expect(result).toContain('</div>');
    });
  });

  describe('separator-based threads (Classic Outlook)', () => {
    const separator = '-----Original Message-----';
    const thread = (levels: number): string => {
      let out = '<p>Current body.</p>';
      for (let i = 1; i <= levels; i++) {
        out += `<p>${separator}</p><p>From: Person ${i}</p><p>Reply ${i} body.</p>`;
      }
      return `<html><body>${out}</body></html>`;
    };

    it('keeps the newest 3 messages and drops older history', () => {
      const result = truncateHtmlThread(thread(4), 3);
      expect(result).toContain('Current body.');
      expect(result).toContain('Reply 1 body.');
      expect(result).toContain('Reply 2 body.');
      expect(result).not.toContain('Reply 3 body.');
      expect(result).not.toContain('Reply 4 body.');
    });

    it('keeps only the current email when keepReplies is 1', () => {
      const result = truncateHtmlThread(thread(4), 1);
      expect(result).toContain('Current body.');
      expect(result).not.toContain('Reply 1 body.');
    });

    it('keeps everything when there are fewer separators than keepReplies', () => {
      const result = truncateHtmlThread(thread(2), 3);
      expect(result).toContain('Current body.');
      expect(result).toContain('Reply 1 body.');
      expect(result).toContain('Reply 2 body.');
    });

    it('preserves a forwarded email whose body starts with the separator', () => {
      const forward =
        '<html><body><p>-----Original Message-----</p><p>From: Alice</p><p>Forwarded body.</p></body></html>';
      const result = truncateHtmlThread(forward, 3);
      expect(result).toContain('Forwarded body.');
      expect(result).toContain('Original Message');
    });

    it('handles Classic Outlook container markers', () => {
      const html =
        '<html><body><p>Current body.</p><div class="OutlookMessageHeader"><p>From: A</p></div><p>Reply 1 body.</p><div class="OutlookMessageHeader"><p>From: B</p></div><p>Reply 2 body.</p><div class="OutlookMessageHeader"><p>From: C</p></div><p>Reply 3 body.</p><div class="OutlookMessageHeader"><p>From: D</p></div><p>Reply 4 body.</p></body></html>';
      const result = truncateHtmlThread(html, 3);
      expect(result).toContain('Current body.');
      expect(result).toContain('Reply 1 body.');
      expect(result).toContain('Reply 2 body.');
      expect(result).not.toContain('Reply 3 body.');
      expect(result).not.toContain('Reply 4 body.');
    });
  });

  describe('horizontal-rule separated threads (fallback signal)', () => {
    it('cuts at <hr> boundaries when no strong markers exist', () => {
      const html =
        '<html><body><p>Current.</p><hr><p>Reply 1.</p><hr><p>Reply 2.</p><hr><p>Reply 3.</p><hr><p>Reply 4.</p></body></html>';
      const result = truncateHtmlThread(html, 3);
      expect(result).toContain('Current.');
      expect(result).toContain('Reply 1.');
      expect(result).toContain('Reply 2.');
      expect(result).not.toContain('Reply 3.');
      expect(result).not.toContain('Reply 4.');
    });

    it('does not treat <hr> inside a single message as thread boundaries when strong markers already meet keepReplies', () => {
      const html =
        '<html><body><p>Body.</p><hr><p>more.</p>-----Original Message-----<p>Reply 1.</p>-----Original Message-----<p>Reply 2.</p>-----Original Message-----<p>Reply 3.</p></body></html>';
      const result = truncateHtmlThread(html, 3);
      expect(result).toContain('Body.');
      expect(result).toContain('Reply 1.');
      expect(result).toContain('Reply 2.');
      expect(result).not.toContain('Reply 3.');
    });
  });
});

describe('splitThreadHtmlMessages', () => {
  const nested = (levels: number): string => {
    let inner = `<p>Reply ${levels + 1} body (oldest).</p>`;
    for (let i = levels; i >= 1; i--) {
      inner = `<blockquote><p>Reply ${i} body.</p>${inner}</blockquote>`;
    }
    return `<html><body><p>Current reply body text.</p>${inner}</body></html>`;
  };

  it('returns [] for blank input', () => {
    expect(splitThreadHtmlMessages('', 3)).toEqual([]);
  });

  it('returns a single fragment when no structural boundary exists', () => {
    const html = '<html><body><p>Just a message.</p></body></html>';
    const parts = splitThreadHtmlMessages(html, 3);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toContain('Just a message.');
  });

  it('splits a blockquote thread into one fragment per message (newest first)', () => {
    const parts = splitThreadHtmlMessages(nested(4), 3);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toContain('Current reply body text.');
    expect(parts[1]).toContain('Reply 1 body.');
    expect(parts[2]).toContain('Reply 2 body.');
    expect(parts[0]).not.toContain('Reply 1 body.');
    expect(parts[1]).not.toContain('Reply 2 body.');
  });

  it('unwraps blockquote tags in each kept fragment', () => {
    const parts = splitThreadHtmlMessages(nested(2), 3);
    expect(parts[1]).toContain('<div>');
    expect(parts[1]).not.toContain('<blockquote');
  });

  it('splits a separator thread into one fragment per message', () => {
    const html = [
      '<html><body>',
      '<p>Current body.</p>',
      '<p>-----Original Message-----</p><p>From: A</p><p>Reply 1 body.</p>',
      '<p>-----Original Message-----</p><p>From: B</p><p>Reply 2 body.</p>',
      '<p>-----Original Message-----</p><p>From: C</p><p>Reply 3 body.</p>',
      '</body></html>',
    ].join('');
    const parts = splitThreadHtmlMessages(html, 3);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toContain('Current body.');
    expect(parts[1]).toContain('Reply 1 body.');
    expect(parts[2]).toContain('Reply 2 body.');
    expect(parts[2]).not.toContain('Reply 3 body.');
  });

  it('caps the number of fragments at keepReplies', () => {
    const parts = splitThreadHtmlMessages(nested(6), 3);
    expect(parts).toHaveLength(3);
  });

  it('returns all messages when fewer than keepReplies exist', () => {
    const parts = splitThreadHtmlMessages(nested(2), 3);
    expect(parts).toHaveLength(3);
  });

  it('splits at the divRplyFwdMsg container at the tag start (not mid-tag)', () => {
    const html = [
      '<html><body>',
      '<p>Current body.</p>',
      '<div id="divRplyFwdMsg" dir="ltr"><p>De: A</p><p>Reply body.</p></div>',
      '</body></html>',
    ].join('');
    const parts = splitThreadHtmlMessages(html, 3);
    expect(parts).toHaveLength(2);
    // The fragment must begin with the full opening tag so emailHtmlToText can strip it.
    expect(parts[1]).toMatch(/^<div id="divRplyFwdMsg"/);
    expect(parts[1]).not.toMatch(/^id="divRplyFwdMsg"/);
    expect(parts[1]).toContain('Reply body.');
  });
});
