/**
 * AI Compose — Router Service Tests
 *
 * Verifies the "single attempt by default" guard: every feature goes through
 * ai-service, so a single default of `maxRetries: 0` prevents silent automatic
 * retries from burning API tokens unbeknown to the user.
 */

import { generateText, generateJson } from './ai-service';
import { generateText as geminiGenerateText, generateJson as geminiGenerateJson } from './gemini';
import {
  generateText as deepseekGenerateText,
  generateJson as deepseekGenerateJson,
} from './deepseek';
import { getSetting } from '../features/settings';

jest.mock('./gemini');
jest.mock('./deepseek');
jest.mock('../features/settings');

const mockGetSetting = getSetting as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('generateText', () => {
  it('defaults to a single attempt (maxRetries: 0) for gemini', async () => {
    mockGetSetting.mockReturnValue('gemini');
    (geminiGenerateText as jest.Mock).mockResolvedValue('ok');

    await generateText('hi');

    expect(geminiGenerateText).toHaveBeenCalledWith(
      'hi',
      expect.objectContaining({ maxRetries: 0 }),
    );
  });

  it('defaults to a single attempt (maxRetries: 0) for deepseek', async () => {
    mockGetSetting.mockReturnValue('deepseek');
    (deepseekGenerateText as jest.Mock).mockResolvedValue('ok');

    await generateText('hi');

    expect(deepseekGenerateText).toHaveBeenCalledWith(
      'hi',
      expect.objectContaining({ maxRetries: 0 }),
    );
  });

  it('honours an explicit maxRetries from the caller', async () => {
    mockGetSetting.mockReturnValue('gemini');
    (geminiGenerateText as jest.Mock).mockResolvedValue('ok');

    await generateText('hi', { maxRetries: 3 });

    expect(geminiGenerateText).toHaveBeenCalledWith(
      'hi',
      expect.objectContaining({ maxRetries: 3 }),
    );
  });
});

describe('generateJson', () => {
  it('defaults to a single attempt (maxRetries: 0) for gemini', async () => {
    mockGetSetting.mockReturnValue('gemini');
    (geminiGenerateJson as jest.Mock).mockResolvedValue({ ok: true });

    await generateJson('hi');

    expect(geminiGenerateJson).toHaveBeenCalledWith(
      'hi',
      expect.objectContaining({ maxRetries: 0 }),
    );
  });

  it('defaults to a single attempt (maxRetries: 0) for deepseek', async () => {
    mockGetSetting.mockReturnValue('deepseek');
    (deepseekGenerateJson as jest.Mock).mockResolvedValue({ ok: true });

    await generateJson('hi');

    expect(deepseekGenerateJson).toHaveBeenCalledWith(
      'hi',
      expect.objectContaining({ maxRetries: 0 }),
    );
  });
});