/**
 * 统一响应信封与错误类型。
 *
 * 判定语义（协议端实测）：
 *   1. Code 存在且为 0 或 200 → 成功
 *   2. Code 不存在 → 回退 Success === true
 *   3. 都无法判定 → 失败
 *
 * 关键反例：/user/SetProxy 返回 Code=200 但 Success=false，
 * 所以绝不能单看 Success。
 */

/** 协议端业务码（取自 api/vo/vo.go） */
export const CodeSuccess = 200;
export const CodeLegacyOK = 0;
export const CodeFailData = -1;
export const CodeFailKey = -2;
export const CodeFailBound = -3;
export const CodeFailOffline = -4;
export const CodeFailNotLocal = -5;
export const CodeFailGeneric = 300;

/** 登录/代理相关的结构化原因码 */
export const ReasonLoginSessionNotFound = 'LOGIN_SESSION_NOT_FOUND';
export const ReasonProxyOffline = 'PROXY_OFFLINE';
export const ReasonAttemptConflict = 'ATTEMPT_CONFLICT';
export const ReasonAttemptMismatch = 'ATTEMPT_MISMATCH';
export const ReasonAttemptInactive = 'ATTEMPT_INACTIVE';
export const ReasonAttemptIDRequired = 'ATTEMPT_ID_REQUIRED';
export const ReasonAttemptNotFound = 'ATTEMPT_NOT_FOUND';
export const ReasonAttemptExpired = 'ATTEMPT_EXPIRED';
export const ReasonCancelled = 'CANCELLED';
export const ReasonWakeScanRequired = 'WAKE_SCAN_REQUIRED';
export const ReasonSecurityReloginNeeded = 'SECURITY_RELOGIN_REQUIRED';
export const ReasonSessionInvalid = 'SESSION_INVALID';
export const ReasonWakeRequestFailed = 'WAKE_REQUEST_FAILED';
export const ReasonLoginRequestFailed = 'LOGIN_REQUEST_FAILED';

/** 所有业务失败的统一错误类型 */
export class APIError extends Error {
  readonly code: number;
  readonly text: string;
  readonly reasonCode: string;
  readonly statusCode: number;
  readonly body: string;

  constructor(opts: {
    code: number;
    text?: string;
    reasonCode?: string;
    statusCode?: number;
    body?: string;
  }) {
    const label = opts.reasonCode
      ? `weixun: code=${opts.code} reason=${opts.reasonCode} msg=${opts.text ?? ''}`
      : `weixun: code=${opts.code} msg=${opts.text ?? ''}`;
    super(label);
    this.name = 'APIError';
    this.code = opts.code;
    this.text = opts.text ?? '';
    this.reasonCode = opts.reasonCode ?? '';
    this.statusCode = opts.statusCode ?? 200;
    this.body = opts.body ?? '';
  }

  /** 是否为 key 无效类错误，调用方据此提示重新登录 */
  isKeyInvalid(): boolean {
    return this.code === CodeFailKey || this.reasonCode === ReasonLoginSessionNotFound;
  }

  /** 是否疑似被风控限流 */
  isRateLimited(): boolean {
    if (this.statusCode === 429) return true;
    return /频繁|限制|frequency/.test(this.text);
  }
}

/** 协议端统一响应结构 */
export interface RawEnvelope {
  Code?: unknown;
  Data?: unknown;
  Text?: string;
  Message?: string;
  Success?: boolean;
  reasonCode?: string;
  attemptId?: string;
  phase?: string;
}

/**
 * 把 Code 解析成整数。
 *
 * 协议端的 Code 可能是 200（数字）或 "200"（字符串），两种都要认。
 */
export function parseCode(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : null;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isInteger(n) ? n : null;
  }
  return null;
}

/** 按协议端真实语义判定成功 */
export function isEnvelopeOK(env: RawEnvelope): boolean {
  const code = parseCode(env.Code);
  if (code !== null) return code === CodeLegacyOK || code === CodeSuccess;
  return env.Success === true;
}

/** 可展示的失败说明。优先 Text，回退 Message（VerifyCode 用 Message） */
export function envelopeMessage(env: RawEnvelope): string {
  const text = (env.Text ?? '').trim();
  if (text) return text;
  return env.Message ?? '';
}

/** 由响应信封构造错误 */
export function errorFromEnvelope(
  env: RawEnvelope,
  statusCode: number,
  body: string,
): APIError {
  const code = parseCode(env.Code) ?? CodeFailGeneric;
  let text = envelopeMessage(env);
  if (!text && statusCode !== 200) text = `HTTP ${statusCode}`;
  return new APIError({
    code,
    text,
    reasonCode: env.reasonCode,
    statusCode,
    body,
  });
}

/**
 * 大整数安全的 JSON 解析。
 *
 * 为什么需要：`new_msg_id` 这类 64 位 ID 超过 2^53，
 * `JSON.parse` 会静默截断（例：199344895681685661 → 199344895681685660）。
 *
 * 实现方式：Node 21 之前 reviver 拿不到原始字面量（context.source），
 * 所以先把「超出安全范围的整数字面量」用正则加上引号，再正常 parse。
 * 这样得到的值与 Go/Python SDK 一致，都是字符串。
 */
export function parseJSONSafe(text: string): unknown {
  // 匹配 JSON 里的裸整数字面量（前面必须是 : [ 或 , 表示是值的位置），
  // 长度超过 15 位的一律按大整数处理（2^53 约 16 位，15 位以内安全）。
  const protectedText = text.replace(
    /([:[,]\s*)(-?\d{16,})(\s*[,\]}])/g,
    (_m, pre: string, num: string, post: string) => `${pre}"${num}"${post}`,
  );
  return JSON.parse(protectedText);
}
