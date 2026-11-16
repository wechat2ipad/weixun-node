/**
 * Client 入口与统一调用出口。
 */

import {
  APIError,
  CodeFailGeneric,
  RawEnvelope,
  errorFromEnvelope,
  isEnvelopeOK,
  parseJSONSafe,
} from './envelope';
import { RateLimiter } from './ratelimit';
import { MessageService } from './message';
import { LoginService } from './login';
import { UploadService } from './upload';

export interface ClientOptions {
  /** 单次请求超时（毫秒），默认 30000 */
  timeoutMs?: number;
  /** 每分钟最多请求数；0 表示关闭限速 */
  rateLimitPerMinute?: number;
  /** User-Agent */
  userAgent?: string;
}

export class Client {
  readonly baseURL: string;
  private readonly licenseKey: string;
  readonly options: Required<ClientOptions>;
  private readonly limiter: RateLimiter | null;

  readonly message: MessageService;
  readonly login: LoginService;
  readonly upload: UploadService;

  /**
   * @param baseURL 形如 http://127.0.0.1:7006，不要带 /api 或 /v1 前缀
   * @param licenseKey 绑定微信账号的协议 license Key
   */
  constructor(baseURL: string, licenseKey: string, options: ClientOptions = {}) {
    this.baseURL = baseURL.replace(/\/+$/, '');
    this.licenseKey = licenseKey;
    this.options = {
      timeoutMs: options.timeoutMs ?? 30_000,
      rateLimitPerMinute: options.rateLimitPerMinute ?? 40,
      userAgent: options.userAgent ?? 'weixun-node/0.1.0',
    };
    this.limiter =
      this.options.rateLimitPerMinute > 0
        ? new RateLimiter(this.options.rateLimitPerMinute, 60_000)
        : null;

    this.message = new MessageService(this);
    this.login = new LoginService(this);
    this.upload = new UploadService(this);
  }

  /** 内部：统一调用出口 */
  async call<T = unknown>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    if (this.limiter) await this.limiter.acquire();

    const url = new URL(`${this.baseURL}${path}`);
    url.searchParams.set('key', this.licenseKey);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);

    let status = 200;
    let text = '';
    try {
      const resp = await fetch(url.toString(), {
        method,
        headers: {
          Accept: 'application/json',
          'User-Agent': this.options.userAgent,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      status = resp.status;
      text = await resp.text();
    } catch (err) {
      throw new APIError({
        code: CodeFailGeneric,
        text: `请求失败: ${(err as Error).message}`,
      });
    } finally {
      clearTimeout(timer);
    }

    // 非 JSON 响应（个别路径返回 {"error":...} 或裸文本）
    if (!text || !text.trimStart().startsWith('{')) {
      throw new APIError({
        code: CodeFailGeneric,
        text: text.trim(),
        statusCode: status,
        body: text,
      });
    }

    let env: RawEnvelope;
    try {
      env = parseJSONSafe(text) as RawEnvelope;
    } catch (err) {
      throw new APIError({
        code: CodeFailGeneric,
        text: `响应不是合法 JSON: ${(err as Error).message}`,
        statusCode: status,
        body: text,
      });
    }

    if (!isEnvelopeOK(env)) {
      throw errorFromEnvelope(env, status, text);
    }
    return env.Data as T;
  }

  /** 内部：供 upload 等需要自定义请求的场景复用 */
  get rawKey(): string {
    return this.licenseKey;
  }

  /** 脱敏后的 key，用于日志 */
  get keyMasked(): string {
    const k = this.licenseKey;
    if (k.length <= 8) return '****';
    return `${k.slice(0, 4)}****${k.slice(-4)}`;
  }
}
