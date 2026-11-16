/** 上传：multipart 大文件 + base64 辅助。 */

import { APIError, CodeFailGeneric } from './envelope';
import { isEnvelopeOK, errorFromEnvelope, RawEnvelope, parseJSONSafe } from './envelope';
import type { Client } from './client';

export const FileTypeImage = 2;
export const FileTypeVideo = 4;
export const FileTypeFile = 5;

export class UploadService {
  constructor(private readonly c: Client) {}

  /** 上传大文件（multipart，≤200MB；协议端唯一的 multipart 接口） */
  async bigFile(opts: {
    filePath: string;
    fileType?: number;
    toUser?: string;
    thumbPath?: string;
  }): Promise<unknown> {
    const fs = await import('node:fs');
    const path = await import('node:path');
    if (!fs.existsSync(opts.filePath)) throw new Error(`文件不存在: ${opts.filePath}`);
    if (fs.statSync(opts.filePath).size > 200 * 1024 * 1024) {
      throw new Error('文件超过 200MB 上限');
    }

    const form = new FormData();
    const buf = fs.readFileSync(opts.filePath);
    form.append('file', new Blob([buf]), path.basename(opts.filePath));
    if (opts.thumbPath && fs.existsSync(opts.thumbPath)) {
      form.append('thumb', new Blob([fs.readFileSync(opts.thumbPath)]), path.basename(opts.thumbPath));
    }
    form.append('fileType', String(opts.fileType ?? FileTypeFile));
    if (opts.toUser) form.append('toUser', opts.toUser);

    const url = new URL(`${this.c.baseURL}/message/CdnBigFileUpload`);
    url.searchParams.set('key', this.c.rawKey);
    const resp = await fetch(url.toString(), { method: 'POST', body: form });
    const text = await resp.text();
    if (!text.trimStart().startsWith('{')) {
      throw new APIError({ code: CodeFailGeneric, text: text.trim(), statusCode: resp.status });
    }
    const env = parseJSONSafe(text) as RawEnvelope;
    if (!isEnvelopeOK(env)) throw errorFromEnvelope(env, resp.status, text);
    return env.Data;
  }

  static base64FromFile(filePath: string, buf: Buffer): string {
    return buf.toString('base64');
  }

  static imageDataURI(mime: string, b: Buffer): string {
    return `data:${mime || 'image/png'};base64,${b.toString('base64')}`;
  }

  static stripDataURI(v: string): string {
    return v.startsWith('data:') && v.includes(',') ? v.split(',')[1] : v;
  }
}
