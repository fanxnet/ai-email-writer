/**
 * AI Compose — Outlook Email Reader Service
 *
 * Provides a clean, typed interface to the Office.js mailbox API
 * for reading email data in both Read and Compose modes.
 *
 * Read mode:  The user is viewing a received email (MessageRead).
 * Compose mode: The user is drafting a new email or reply (MessageCompose).
 *
 * © Rizonetech (Pty) Ltd. — https://rizonesoft.com
 */

/* global Office */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Represents an email participant (sender, recipient, etc.). */
export interface EmailContact {
  /** Display name, e.g. "Alice Smith" */
  name: string;
  /** Email address, e.g. "alice@example.com" */
  email: string;
}

/** Represents a single message in a conversation thread. */
export interface EmailMessage {
  /** The message subject */
  subject: string;
  /** The message body (plain text) */
  body: string;
  /** The sender of this message */
  sender: EmailContact;
  /** When the message was sent (if available) */
  dateTime?: string;
}

/** The mode in which the add-in is operating. */
export type ItemMode = 'read' | 'compose' | 'unknown';

// ---------------------------------------------------------------------------
// Mode detection
// ---------------------------------------------------------------------------

/**
 * Determine whether the current mailbox item is in Read or Compose mode.
 */
export function getItemMode(): ItemMode {
  const item = Office.context.mailbox.item;
  if (!item) return 'unknown';

  // In compose mode, item.itemType is still defined but
  // subject/body are async setters rather than direct properties.
  // The best indicator is checking for the "getAsync" pattern on body.
  if (typeof (item as any).body?.getAsync === 'function') {
    // Both modes have body.getAsync since Office 1.3,
    // but compose mode also has body.setAsync
    if (typeof (item as any).body?.setAsync === 'function') {
      return 'compose';
    }
  }

  // Also check: in read mode, subject is a direct string property.
  // In compose mode, subject is an object with getAsync/setAsync.
  if (typeof item.subject === 'string') {
    return 'read';
  }

  if (typeof (item.subject as any)?.getAsync === 'function') {
    return 'compose';
  }

  return 'unknown';
}

// ---------------------------------------------------------------------------
// Email body
// ---------------------------------------------------------------------------
/**
 * Strip HTML tags from email content, preserving only the display text of
 * hyperlinks (discarding href targets) and paragraph line breaks.
 * This ensures the AI prompt receives human-readable, well-structured text.
 * 
 * @param html - HTML string of the email body
 * @param options.stripQuoted - Whether to remove quoted/replied content (default: false)
 */
  /** 是否移除历史引用块，false = 全部保留历史邮件正文 */

export function emailHtmlToText(
  html: string,
  options: EmailHtmlToTextOptions = {},
): string {
  const { stripQuoted = false } = options;

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // 递归删除HTML注释
  const removeComments = (root: Node) => {
    const nodes = Array.from(root.childNodes);
    for (const node of nodes) {
      if (node.nodeType === Node.COMMENT_NODE) {
        node.remove();
      } else if (node.hasChildNodes()) {
        removeComments(node);
      }
    }
  };
  removeComments(doc.body);

  // 移除脚本、样式，不属于邮件正文
  doc.querySelectorAll('style,script,noscript').forEach(el => el.remove());

  // 仅开启stripQuoted时才删除引用；默认所有历史邮件完整保留
  if (stripQuoted) {
    const quoteSelectors = [
      'blockquote',
      'div.gmail_quote',
      'div[id="gmail_quote"]',
      'div.yahoo_quoted',
      '.mail_quote',
      '.outlookQuote',
      '.replyQuote',
      'div.quote'
    ];
    quoteSelectors.forEach(sel => {
      doc.querySelectorAll(sel).forEach(el => el.remove());
    });
  }

  // 列表项添加项目符号
  doc.querySelectorAll('li').forEach(li => {
    if (!li.textContent?.startsWith('• ')) {
      const textNode = doc.createTextNode('• ');
      li.insertBefore(textNode, li.firstChild);
    }
  });

  // innerText还原布局换行，表格、复杂邮件布局不会丢内容
  let text = doc.body.innerText;

  // 强制清理Emoji表情包（永久生效）
  const emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{200D}]/gu;
  text = text.replace(emojiRegex, '');

  // 清除Outlook零宽隐形字符，解决换行错乱
  const zeroWidthChars = /[\u2000-\u200F\u2028-\u202F]/g;
  text = text.replace(zeroWidthChars, ' ');

  // 规整多余空格和空行
  text = text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}

/**
 * Read the body of the currently open email as plain text.
 * Internally fetches HTML and strips tags, so hyperlink display text is
 * preserved while raw URLs are discarded.
 * Works in both Read and Compose modes.
 */
export async function getCurrentEmailBody(): Promise<string> {
  const html = await getCurrentEmailBodyHtml();
  return emailHtmlToText(html);
}

/**
 * Read the body of the currently open email as HTML.
 * Useful when preserving formatting is important.
 */
export function getCurrentEmailBodyHtml(): Promise<string> {
  return new Promise((resolve, reject) => {
    const item = getItemOrThrow();

    item.body.getAsync(
      Office.CoercionType.Html,
      { bodyMode: Office.MailboxEnums.BodyMode.HostConfig },
      (result: Office.AsyncResult<string>) => {
        if (result.status === Office.AsyncResultStatus.Succeeded) {
          resolve(result.value || '');
        } else {
          reject(
            new Error(`Failed to read email body (HTML): ${result.error?.message || 'Unknown error'}`),
          );
        }
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

/**
 * Read the subject of the currently open email.
 * Handles both Read mode (direct property) and Compose mode (async getter).
 */
export function getCurrentEmailSubject(): Promise<string> {
  return new Promise((resolve, reject) => {
    const item = getItemOrThrow();

    // Read mode: subject is a direct string property
    if (typeof item.subject === 'string') {
      resolve(item.subject);
      return;
    }

    // Compose mode: subject is an object with getAsync
    const subjectObj = item.subject as any;
    if (typeof subjectObj?.getAsync === 'function') {
      subjectObj.getAsync((result: Office.AsyncResult<string>) => {
        if (result.status === Office.AsyncResultStatus.Succeeded) {
          resolve(result.value || '');
        } else {
          reject(
            new Error(`Failed to read email subject: ${result.error?.message || 'Unknown error'}`),
          );
        }
      });
      return;
    }

    resolve('');
  });
}

// ---------------------------------------------------------------------------
// Sender
// ---------------------------------------------------------------------------

/**
 * Get the sender of the currently open email.
 *
 * - Read mode:  Returns the `from` field of the received message.
 * - Compose mode: Returns the current user's account info (they are the sender).
 */
export function getEmailSender(): Promise<EmailContact> {
  return new Promise((resolve, reject) => {
    const item = getItemOrThrow();

    // Read mode: item.from is a direct EmailAddressDetails object
    if ((item as Office.MessageRead).from) {
      const from = (item as Office.MessageRead).from;
      resolve({
        name: from.displayName || '',
        email: from.emailAddress || '',
      });
      return;
    }

    // Compose mode: the sender is the current user
    // Use item.from.getAsync if available (Requirement set 1.7+)
    const fromObj = (item as any).from;
    if (fromObj && typeof fromObj.getAsync === 'function') {
      fromObj.getAsync((result: Office.AsyncResult<Office.EmailAddressDetails>) => {
        if (result.status === Office.AsyncResultStatus.Succeeded && result.value) {
          resolve({
            name: result.value.displayName || '',
            email: result.value.emailAddress || '',
          });
        } else {
          // Fallback: use the mailbox user profile
          resolve(getCurrentUserContact());
        }
      });
      return;
    }

    // Fallback: use the mailbox user profile
    resolve(getCurrentUserContact());
  });
}

/**
 * Get the original sender of the email being replied to.
 *
 * - Read mode: Returns the `from` field (same as getEmailSender).
 * - Compose mode (reply): Returns the first To recipient, who is
 *   the person the user is replying to.
 * - Compose mode (new): Falls back to the current user.
 */
export async function getOriginalSender(): Promise<EmailContact> {
  const mode = getItemMode();

  if (mode === 'read') {
    return getEmailSender();
  }

  // In compose mode, the first To recipient is the person being replied to
  const item = getItemOrThrow();
  const toRecipients = await getComposeToRecipients(item);

  if (toRecipients.length > 0) {
    return toRecipients[0];
  }

  // Fallback for new compose (no recipients yet)
  return getEmailSender();
}

/** Get only the To recipients in compose mode. */
function getComposeToRecipients(item: any): Promise<EmailContact[]> {
  return new Promise((resolve) => {
    const toObj = item.to;
    if (toObj && typeof toObj.getAsync === 'function') {
      toObj.getAsync((result: Office.AsyncResult<Office.EmailAddressDetails[]>) => {
        if (result.status === Office.AsyncResultStatus.Succeeded && result.value) {
          resolve(
            result.value.map((r) => ({
              name: r.displayName || '',
              email: r.emailAddress || '',
            })),
          );
        } else {
          resolve([]);
        }
      });
    } else {
      resolve([]);
    }
  });
}

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

/**
 * Get all recipients (To, CC) of the currently open email.
 * Returns a flat array combining To and CC fields.
 */
export function getEmailRecipients(): Promise<EmailContact[]> {
  const item = getItemOrThrow();
  const mode = getItemMode();

  if (mode === 'read') {
    return getReadModeRecipients(item as Office.MessageRead);
  } else {
    return getComposeModeRecipients(item);
  }
}

/** Read mode: To and CC are direct arrays. */
function getReadModeRecipients(item: Office.MessageRead): Promise<EmailContact[]> {
  const contacts: EmailContact[] = [];

  if (item.to) {
    for (const r of item.to) {
      contacts.push({ name: r.displayName || '', email: r.emailAddress || '' });
    }
  }

  if (item.cc) {
    for (const r of item.cc) {
      contacts.push({ name: r.displayName || '', email: r.emailAddress || '' });
    }
  }

  return Promise.resolve(contacts);
}

/** Compose mode: To and CC require getAsync calls. */
function getComposeModeRecipients(item: any): Promise<EmailContact[]> {
  return new Promise((resolve, reject) => {
    const contacts: EmailContact[] = [];
    let pending = 0;
    let hasError = false;

    const tryResolve = () => {
      if (pending === 0 && !hasError) {
        resolve(contacts);
      }
    };

    const processRecipientList = (recipientObj: any) => {
      if (recipientObj && typeof recipientObj.getAsync === 'function') {
        pending++;
        recipientObj.getAsync((result: Office.AsyncResult<Office.EmailAddressDetails[]>) => {
          if (result.status === Office.AsyncResultStatus.Succeeded && result.value) {
            for (const r of result.value) {
              contacts.push({ name: r.displayName || '', email: r.emailAddress || '' });
            }
          }
          pending--;
          tryResolve();
        });
      }
    };

    processRecipientList(item.to);
    processRecipientList(item.cc);

    // If neither field had getAsync, resolve immediately
    if (pending === 0) {
      resolve(contacts);
    }
  });
}

// ---------------------------------------------------------------------------
// Conversation / Thread
// ---------------------------------------------------------------------------

/**
 * Attempt to retrieve conversation messages for the current email thread.
 *
 * **Note:** The Office.js mailbox API does not provide direct access to
 * all messages in a conversation thread. This function returns the current
 * message's data. For full thread access, you would need the Microsoft
 * Graph API (`/me/messages?$filter=conversationId eq '...'`).
 *
 * This function returns a single-element array with the current message
 * as a starting point. The Graph-based implementation can be added in
 * Phase 5 when Microsoft Graph integration is set up.
 */
export async function getConversationMessages(): Promise<EmailMessage[]> {
  const [body, subject, sender] = await Promise.all([
    getCurrentEmailBody(),
    getCurrentEmailSubject(),
    getEmailSender(),
  ]);

  const item = Office.context.mailbox.item;
  const dateTime = (item as Office.MessageRead)?.dateTimeCreated?.toISOString?.() || undefined;

  return [
    {
      subject,
      body,
      sender,
      dateTime,
    },
  ];
}

/**
 * Get the conversation ID for the current email.
 * This can be used later with the Microsoft Graph API to fetch
 * all messages in the same conversation thread.
 */
export function getConversationId(): string | undefined {
  const item = Office.context.mailbox.item;
  if (!item) return undefined;
  return (item as any).conversationId || undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the currently active mailbox item, or throw if none is available.
 */
function getItemOrThrow(): any {
  const item = Office.context.mailbox.item;
  if (!item) {
    throw new Error(
      'No mailbox item is currently open. Make sure the add-in is activated on an email.',
    );
  }
  return item as any;
}

/**
 * Get the current user's contact info from the mailbox user profile.
 * This is used as a fallback for the sender in compose mode.
 */
function getCurrentUserContact(): EmailContact {
  const profile = Office.context.mailbox.userProfile;
  return {
    name: profile?.displayName || '',
    email: profile?.emailAddress || '',
  };
}
