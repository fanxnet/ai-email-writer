/**
 * AI Compose — Auto-save Service Unit Tests
 *
 * Covers the persisted draft-output store (single global slot, 24h TTL):
 * save / read round-trips, overwriting, clearing, and expiry.
 */

import { saveDraftOutput, getDraftOutput, clearDraftOutput, SavedDraftOutput } from './auto-save';

// ---------------------------------------------------------------------------
// localStorage mock (jest testEnvironment is node, not jsdom)
// ---------------------------------------------------------------------------

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  get length(): number {
    return this.store.size;
  }
}

beforeEach(() => {
  (global as unknown as { localStorage: Storage }).localStorage = new MemoryStorage() as unknown as Storage;
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

afterEach(() => {
  jest.useRealTimers();
});

const options = { instructions: 'Draft a follow-up', tone: 'professional', length: 'medium' };
const options2 = { instructions: 'Draft a reminder', tone: 'friendly', length: 'short' };

// ---------------------------------------------------------------------------
// saveDraftOutput / getDraftOutput
// ---------------------------------------------------------------------------

describe('draft output store', () => {
  it('round-trips a saved draft with its options', () => {
    saveDraftOutput('Subject: Hi\n\nBody text', options);

    const saved = getDraftOutput();
    expect(saved).not.toBeNull();
    expect(saved!.draft).toBe('Subject: Hi\n\nBody text');
    expect(saved!.options).toEqual(options);
    expect(saved!.savedAt).toBe(Date.now());
  });

  it('overwrites the previous draft with the latest one', () => {
    saveDraftOutput('First draft', options);
    saveDraftOutput('Second draft', options2);

    const saved = getDraftOutput();
    expect(saved!.draft).toBe('Second draft');
    expect(saved!.options).toEqual(options2);
  });

  it('returns null when nothing has been saved', () => {
    expect(getDraftOutput()).toBeNull();
  });

  it('returns null and discards the entry when the 24h window has expired', () => {
    saveDraftOutput('Stale draft', options);

    // 24h exactly is still valid
    jest.setSystemTime(new Date('2026-01-02T00:00:00Z'));
    expect(getDraftOutput()).not.toBeNull();

    // A moment past 24h is expired
    jest.setSystemTime(new Date('2026-01-02T00:00:01Z'));
    expect(getDraftOutput()).toBeNull();
  });

  it('returns null and cleans up malformed stored data', () => {
    (global as unknown as { localStorage: Storage }).localStorage.setItem(
      'aic_draft_output',
      '{not valid json',
    );
    expect(getDraftOutput()).toBeNull();

    (global as unknown as { localStorage: Storage }).localStorage.setItem(
      'aic_draft_output',
      JSON.stringify({ draft: 'missing options and savedAt' }),
    );
    expect(getDraftOutput()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// clearDraftOutput
// ---------------------------------------------------------------------------

describe('clearDraftOutput', () => {
  it('removes the saved draft output', () => {
    saveDraftOutput('Draft to clear', options);
    expect(getDraftOutput()).not.toBeNull();

    clearDraftOutput();
    expect(getDraftOutput()).toBeNull();
  });

  it('is safe to call when nothing is saved', () => {
    expect(() => clearDraftOutput()).not.toThrow();
  });
});
