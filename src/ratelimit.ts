/**
 * 令牌桶限速器。
 *
 * 为什么 SDK 必须自带限速：协议端实测没有任何服务端限流，
 * 客户并发猛发不会收到 API 错误，而是直接被微信风控。
 */
export class RateLimiter {
  private tokens: number;
  private last: number;
  private readonly intervalMs: number;

  constructor(private readonly capacity: number, perWindowMs: number) {
    if (capacity <= 0) throw new Error('capacity 必须大于 0');
    this.intervalMs = perWindowMs / capacity;
    this.tokens = capacity;
    this.last = Date.now();
  }

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      const elapsed = now - this.last;
      this.tokens = Math.min(this.capacity, this.tokens + elapsed / this.intervalMs);
      this.last = now;

      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const need = (1 - this.tokens) * this.intervalMs;
      await new Promise((r) => setTimeout(r, Math.max(need, 1)));
    }
  }
}

/** 强制两次调用之间的最小间隔 */
export class Throttle {
  private last = 0;
  constructor(private readonly minMs: number) {}

  async wait(): Promise<void> {
    if (this.minMs <= 0) return;
    const elapsed = Date.now() - this.last;
    this.last = Date.now();
    if (elapsed < this.minMs) {
      await new Promise((r) => setTimeout(r, this.minMs - elapsed));
    }
  }
}
