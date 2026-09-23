import type { EmailDetail, EmailSummary, OriginalForReply, SearchCriteria } from './message.js';

export interface ListParams {
  folder: string;
  limit: number;
  unreadOnly: boolean;
}

export interface ListResult {
  folder: string;
  total?: number;
  emails: EmailSummary[];
  note?: string;
}

export interface GetParams {
  uid: string;
  folder: string;
  format: 'full' | 'headers';
  includeAttachments: boolean;
}

export interface SearchParams extends SearchCriteria {
  folder: string;
  limit: number;
}

export interface Receiver {
  readonly protocol: 'imap' | 'pop3';
  list(p: ListParams): Promise<ListResult>;
  get(p: GetParams): Promise<EmailDetail>;
  search(p: SearchParams): Promise<ListResult>;
  /** Locate the original message for reply_email. */
  getOriginal(p: { uid?: string; messageId?: string; folder: string }): Promise<OriginalForReply>;
}

export interface FolderInfo {
  path: string;
  name: string;
  delimiter?: string;
  special_use?: string;
  messages?: number;
  unseen?: number;
}

export interface ImapExtras {
  listFolders(): Promise<FolderInfo[]>;
  markRead(p: { uid: string; folder: string; read: boolean }): Promise<{ uid: string; folder: string; seen: boolean }>;
}
