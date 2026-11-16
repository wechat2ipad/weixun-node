/** 扫码登录状态机。 */

import { APIError, CodeFailGeneric, ReasonSecurityReloginNeeded } from './envelope';
import type { Client } from './client';

export interface LoginState {
  state: number;
  loginState: string;
  nextStep: string;
  qrCodeUrl: string;
  wxid: string;
  message: string;
  attemptId: string;
}

export class LoginService {
  constructor(private readonly c: Client) {}

  static parse(data: unknown): LoginState {
    const d = (data ?? {}) as Record<string, unknown>;
    return {
      state: Number(d.state ?? 0),
      loginState: String(d.loginState ?? ''),
      nextStep: String(d.nextStep ?? ''),
      qrCodeUrl: String(d.qrCodeUrl ?? d.QrCodeUrl ?? ''),
      wxid: String(d.wxid ?? ''),
      message: String(d.msg ?? ''),
      attemptId: String(d.attemptId ?? ''),
    };
  }

  static isOnline(st: LoginState): boolean {
    return st.loginState === 'online';
  }
  static needIpadConfirm(st: LoginState): boolean {
    return st.loginState === 'ipad_required';
  }
  static needSecurityVerify(st: LoginState): boolean {
    return st.loginState === 'security_verify_required';
  }
  static isTerminal(st: LoginState): boolean {
    return LoginService.isOnline(st) || LoginService.needSecurityVerify(st);
  }

  /** 获取登录二维码（协议端要求同 key 同时只有一个活跃尝试，15 分钟 TTL） */
  async getQrCode(device = 'ipad'): Promise<LoginState> {
    const data = await this.c.call('POST', '/login/GetLoginQrCodeNewDirect', { device });
    return LoginService.parse(data);
  }

  /** 查询登录进度，建议每 2.5 秒一次 */
  async checkStatus(attemptId = ''): Promise<LoginState> {
    const body: Record<string, unknown> = {};
    if (attemptId) body.attemptId = attemptId;
    const data = await this.c.call('POST', '/login/CheckLoginStatus', body);
    const st = LoginService.parse(data);
    if (!st.attemptId) st.attemptId = attemptId;
    return st;
  }

  /** 阻塞等待登录完成 */
  async waitForOnline(
    attemptId = '',
    intervalMs = 2500,
    timeoutMs = 300_000,
  ): Promise<LoginState> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const st = await this.checkStatus(attemptId);
      if (LoginService.isOnline(st)) return st;
      if (LoginService.needSecurityVerify(st)) {
        throw new APIError({
          code: CodeFailGeneric,
          text: '需要安全验证，必须重新发起登录',
          reasonCode: ReasonSecurityReloginNeeded,
        });
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new APIError({ code: CodeFailGeneric, text: '等待登录超时' });
  }

  async cancel(attemptId = ''): Promise<void> {
    const body: Record<string, unknown> = {};
    if (attemptId) body.attemptId = attemptId;
    await this.c.call('POST', '/login/CancelLogin', body);
  }

  async getLoginStatus(): Promise<unknown> {
    return this.c.call('GET', '/login/GetLoginStatus');
  }

  async wakeUp(attemptId = ''): Promise<LoginState> {
    const body: Record<string, unknown> = {};
    if (attemptId) body.attemptId = attemptId;
    const data = await this.c.call('POST', '/login/WakeUpLogin', body);
    return LoginService.parse(data);
  }
}
