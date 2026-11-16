/**
 * WebSocket 实时消息流。
 *
 * 协议端约束：
 *  - 鉴权只有 query 参数 key
 *  - 同一 key 只允许一条连接，新连接顶掉旧连接
 *  - 断线期间消息不补发
 *  - 服务端 60 秒 ping / 读超时 300 秒
 *  - 裸文本帧 "pong" / "sync completed"
 *  - 帧结构 {key, message, type}，内部字符串包在 {"str": ...}
 *  - 另有 type=record_content 事件
 */

import WebSocket from 'ws';
import { parseJSONSafe } from './envelope';
import type { Client } from './client';

export interface Message {
  msgId: number;
  /** 64 位消息 ID，字符串形式（超过 2^53） */
  newMsgId: string;
  from: string;
  to: string;
  type: number;
  content: string;
  createTime: number;
  pushContent: string;
  raw: Record<string, unknown>;
}

export interface RecordContentEvent {
  messageId: string;
  talker: string;
  success: boolean;
  content: string;
  length: number;
  timestamp: number;
  error: string;
}

export interface StreamOptions {
  onMessage?: (m: Message) => void;
  onRecordContent?: (e: RecordContentEvent) => void;
  onError?: (e: Error) => void;
  onStateChange?: (s: string) => void;
  maxBackoffMs?: number;
}

/** 处理协议端两种字符串表达：{"str":"xxx"} 或裸字符串 */
export function unwrapString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    const s = (v as Record<string, unknown>).str;
    return typeof s === 'string' ? s : '';
  }
  return '';
}

/** 解析 message 节点 */
export function parseAddMsg(node: unknown): Message | null {
  if (!node || typeof node !== 'object') return null;
  const n = node as Record<string, unknown>;
  return {
    msgId: Number(n.msg_id ?? 0),
    newMsgId: String(n.new_msg_id ?? ''),
    from: unwrapString(n.from_user_name),
    to: unwrapString(n.to_user_name),
    type: Number(n.msg_type ?? 0),
    content: unwrapString(n.content),
    createTime: Number(n.create_time ?? 0),
    pushContent: String(n.push_content ?? ''),
    raw: n,
  };
}

/** 解析一帧原始文本，分派到回调 */
export function dispatchFrame(raw: string, opts: StreamOptions): void {
  const text = raw.trim();
  if (!text || !text.startsWith('{')) return; // 裸文本控制帧直接忽略
  let frame: Record<string, unknown>;
  try {
    frame = parseJSONSafe(text) as Record<string, unknown>;
  } catch (err) {
    opts.onError?.(err as Error);
    return;
  }
  if (frame.type === 'message') {
    const msg = parseAddMsg(frame.message);
    if (msg) opts.onMessage?.(msg);
  } else if (frame.type === 'record_content') {
    opts.onRecordContent?.({
      messageId: String(frame.message_id ?? ''),
      talker: String(frame.talker ?? ''),
      success: Boolean(frame.success),
      content: String(frame.content ?? ''),
      length: Number(frame.length ?? 0),
      timestamp: Number(frame.timestamp ?? 0),
      error: String(frame.error ?? ''),
    });
  }
}

export class Stream {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoffMs = 1000;

  constructor(
    private readonly c: Client,
    private readonly opts: StreamOptions = {},
  ) {}

  private wsURL(): string {
    let base = this.c.baseURL;
    if (base.startsWith('https://')) base = `wss://${base.slice(8)}`;
    else if (base.startsWith('http://')) base = `ws://${base.slice(7)}`;
    return `${base.replace(/\/+$/, '')}/ws/GetSyncMsg?key=${encodeURIComponent(this.c.rawKey)}`;
  }

  start(): this {
    this.stopped = false;
    this.connect();
    return this;
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    if (this.stopped) return;
    this.opts.onStateChange?.('connecting');
    const ws = new WebSocket(this.wsURL());
    this.ws = ws;

    ws.on('open', () => {
      this.backoffMs = 1000; // 连上即重置退避
      this.opts.onStateChange?.('connected');
    });
    ws.on('message', (data) => dispatchFrame(data.toString(), this.opts));
    ws.on('error', (err) => this.opts.onError?.(err));
    ws.on('close', () => {
      if (this.stopped) return;
      this.opts.onStateChange?.('reconnecting');
      setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs ?? 60_000);
    });
  }
}
