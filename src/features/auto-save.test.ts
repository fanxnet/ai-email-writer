/**
 * AI Compose — Auto-save Service Unit Tests
 *
 * Covers the persisted draft-output store (single global slot, 24h TTL):
 * save / read round-trips, overwriting, clearing, and expiry. Also covers the
 * draft-instructions history (global slot, 24h TTL, ≤5 distinct values).
 */

import {
  saveDraftOutput,
  getDraftOutput,
  clearDraftOutput,
  saveDraftInstructions,
  getDraftInstructions,
  clearDraftInstructions,
  SavedDraftOutput,
} from './auto-save';

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

// ---------------------------------------------------------------------------
// Draft instructions (global slot, 24h TTL, ≤5 distinct values)
// ---------------------------------------------------------------------------

describe('draft instructions store', () => {
  it('round-trips the most recent instructions', () => {
    saveDraftInstructions('Draft a follow-up email to the client');
    expect(getDraftInstructions()).toBe('Draft a follow-up email to the client');
  });

  it('returns the most recent instructions after multiple saves', () => {
    saveDraftInstructions('First set of draft instructions here');
    saveDraftInstructions('Second set of draft instructions here');
    expect(getDraftInstructions()).toBe('Second set of draft instructions here');
  });

  it('ignores content shorter than MIN_LENGTH (20 chars)', () => {
    saveDraftInstructions('Short');
    expect(getDraftInstructions()).toBeNull();
  });

  it('does not duplicate identical values and refreshes it to the front', () => {
    const instructions = 'Repeated instructions content here';
    saveDraftInstructions(instructions);
    saveDraftInstructions('A different set of instructions here');
    saveDraftInstructions(instructions);

    expect(getDraftInstructions()).toBe(instructions);
    // Exactly 2 distinct entries are kept (no duplicate of the repeated value).
    const raw = (global as unknown as { localStorage: Storage }).localStorage.getItem(
      'aic_draft_instructions',
    );
    const parsed = JSON.parse(raw as string) as Array<{ instructions: string }>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0].instructions).toBe(instructions);
  });

  it('keeps at most the 5 most recent distinct values', () => {
    for (let i = 1; i <= 6; i++) {
      saveDraftInstructions(`Instructions set number ${i}`);
    }

    const raw = (global as unknown as { localStorage: Storage }).localStorage.getItem(
      'aic_draft_instructions',
    );
    const parsed = JSON.parse(raw as string) as Array<{ instructions: string }>;
    expect(parsed).toHaveLength(5);
    // Newest first; the oldest ("set number 1") is evicted.
    expect(parsed[0].instructions).toBe('Instructions set number 6');
    expect(parsed[4].instructions).toBe('Instructions set number 2');
  });

  it('discards entries older than the 24h window', () => {
    saveDraftInstructions('Fresh instructions content here');

    // 24h exactly is still valid
    jest.setSystemTime(new Date('2026-01-02T00:00:00Z'));
    expect(getDraftInstructions()).toBe('Fresh instructions content here');

    // A moment past 24h is expired
    jest.setSystemTime(new Date('2026-01-02T00:00:01Z'));
    expect(getDraftInstructions()).toBeNull();
  });
});

describe('clearDraftInstructions', () => {
  it('removes the saved draft instructions', () => {
    saveDraftInstructions('Instructions to clear here');
    expect(getDraftInstructions()).not.toBeNull();

    clearDraftInstructions();
    expect(getDraftInstructions()).toBeNull();
  });
});
