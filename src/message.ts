/**
 * 消息服务：发送、群发、撤回，以及逐条结果归一化。
 */

import type { Client } from './client';

export const MsgTypeText = 1;
export const MsgTypeImage = 3;
export const MsgTypeVoice = 34;
export const MsgTypeCard = 42;
export const MsgTypeVideo = 43;
export const MsgTypeSticker = 47;
export const MsgTypeLocation = 48;
export const MsgTypeApp = 49;
export const MsgTypeSystem = 10000;
export const MsgTypeRevoke = 10002;

const SUCCESS_FLAGS = [
  'isSendSuccess',
  'isCommentSuccess',
  'isMarkSuccess',
  'isHideSuccess',
  'isFollowSuccess',
  'isUploadSuccess',
  'isSuccess',
] as const;
const TO_KEYS = ['toUSerName', 'toUserName', 'to_user_name'] as const;
const ERROR_KEYS = ['errMsg', 'errMgs', 'error'] as const;

export interface SendTextRequest {
  /** 接收方 wxid 或 xxx@chatroom */
  to: string;
  /** 消息内容 */
  text: string;
  /** 需要 @ 的成员 wxid 列表 */
  at?: string[];
}

export interface SendTextResult {
  ok: boolean;
  to: string;
  errorMessage: string;
  raw: Record<string, unknown>;
}

/**
 * 把协议端五花八门的逐条结果统一。
 *
 * 字段差异（实测）：
 *  - toUSerName（14处）/ toUserName（9处）
 *  - 成功标志 7 种命名
 *  - errMsg / errMgs（拼写错误）
 */
export function parseBatchResults(data: unknown): SendTextResult[] {
  if (data === null || data === undefined) return [];
  const items: Record<string, unknown>[] = Array.isArray(data)
    ? (data.filter((x) => x && typeof x === 'object') as Record<string, unknown>[])
    : typeof data === 'object'
      ? [data as Record<string, unknown>]
      : [];
  if (!items.length) return [];

  return items.map((item) => {
    const to =
      TO_KEYS.map((k) => item[k]).find((v): v is string => typeof v === 'string' && !!v) ?? '';
    const err =
      ERROR_KEYS.map((k) => item[k]).find((v): v is string => typeof v === 'string' && !!v) ?? '';
    const hasFlag = SUCCESS_FLAGS.some((f) => f in item);
    let ok = hasFlag ? SUCCESS_FLAGS.some((f) => item[f] === true) : true;
    if (err) ok = false;
    return { ok, to, errorMessage: err, raw: item };
  });
}

export class MessageService {
  constructor(private readonly c: Client) {}

  async sendText(req: SendTextRequest): Promise<SendTextResult> {
    const results = await this.sendTextBatch([req]);
    if (!results.length) throw new Error('协议端未返回发送结果');
    return results[0];
  }

  async sendTextBatch(reqs: SendTextRequest[]): Promise<SendTextResult[]> {
    if (!reqs.length) throw new Error('至少需要一条消息');
    const items = reqs.map((r) => {
      if (!r.to) throw new Error('接收方不能为空');
      const item: Record<string, unknown> = {
        ToUserName: r.to,
        TextContent: r.text,
        MsgType: 1,
      };
      if (r.at?.length) item.AtWxIDList = r.at;
      return item;
    });
    const data = await this.c.call('POST', '/message/SendTextMessage', { MsgItem: items });
    return parseBatchResults(data);
  }

  async sendImage(to: string, imageBase64: string): Promise<SendTextResult> {
    const data = await this.c.call('POST', '/message/SendImageMessage', {
      MsgItem: [{ ToUserName: to, ImageContent: imageBase64, MsgType: 2 }],
    });
    const results = parseBatchResults(data);
    if (!results.length) throw new Error('协议端未返回发送结果');
    return results[0];
  }

  async groupMassText(to: string[], content: string): Promise<unknown> {
    if (!to.length) throw new Error('收件人列表不能为空');
    return this.c.call('POST', '/message/GroupMassMsgText', { ToUserName: to, Content: content });
  }

  async revoke(to: string, newMsgId: string, clientMsgId: string): Promise<void> {
    await this.c.call('POST', '/message/RevokeMsg', {
      ToUserName: to,
      NewMsgId: newMsgId,
      ClientMsgId: clientMsgId,
    });
  }

  async markAllRead(to: string): Promise<void> {
    await this.c.call('POST', '/message/MarkAllMessagesAsRead', { ToUserName: to });
  }

  async setCallback(callbackUrl: string): Promise<void> {
    await this.c.call('POST', '/message/SetCallback', { CallbackUrl: callbackUrl });
  }
}

export function isContactSync(msgType: number): boolean {
  return msgType === MsgTypeSystem;
}

export function isRevoke(msgType: number): boolean {
  return msgType === MsgTypeRevoke;
}
