/**
 * AI Compose — Prompt Test Handler
 *
 * 专门处理 prompt-test 模式：在返回原始 prompt 之前刷新 UI。
 * 与 ai-service.ts 解耦，提供下列核心函数：
 *   - refreshUiForPromptTest(): 刷新结果区域显示
 *   - getPromptText(): 完整流程（刷新 UI + 返回 prompt）
 */

// 在返回 prompt 之前刷新 UI (结果区域显示)
export function refreshUiForPromptTest(): void {
  // 尝试查找常见的结果预览区域元素并显示
  const resultSelectors = [
    '#reply-preview',
    '#draft-preview',
    '.aic-preview',
  ];

  for (const selector of resultSelectors) {
    const el = document.querySelector(selector) as HTMLElement | null;
    if (el) {
      el.classList.remove('hidden');
    }
  }
}

// 完整处理流程：刷新 UI 并返回 prompt
export function getPromptText(
  prompt: string, 
  onStream?: (delta: string) => void
): string {
  refreshUiForPromptTest();
  if (onStream) {
    onStream(prompt);  // Call streaming callback to update UI
  }
  return prompt;
}

