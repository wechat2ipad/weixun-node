/**
 * Conformance 测试：读取契约仓的同一批 fixtures，验证 TS SDK 行为与其他语言一致。
 *
 * 运行：npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseCode,
  isEnvelopeOK,
  envelopeMessage,
  errorFromEnvelope,
  parseJSONSafe,
  APIError,
  CodeFailKey,
} from '../dist/envelope.js';
import { parseBatchResults } from '../dist/message.js';
import { parseAddMsg, unwrapString, dispatchFrame } from '../dist/stream.js';
import { LoginService } from '../dist/login.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [
  path.join(__dirname, '..', 'conformance', 'fixtures'),
  path.join(__dirname, '..', '..', 'weixun-api-contract', 'fixtures'),
];
const FIXTURES = CANDIDATES.find((p) => fs.existsSync(p));

function load(rel) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, rel), 'utf8'));
}

// ── envelope ────────────────────────────────────────

test('envelope: 标准成功', () => {
  const fx = load('envelope/01-ok.json');
  assert.equal(isEnvelopeOK(fx.input), fx.expect.ok);
  assert.equal(parseCode(fx.input.Code), fx.expect.code);
});

test('envelope: Code 是字符串 "200"', () => {
  const fx = load('envelope/02-code-string.json');
  assert.equal(isEnvelopeOK(fx.input), true);
  assert.equal(parseCode(fx.input.Code), 200);
});

test('envelope: Code=200 但 Success=false（关键反例）', () => {
  const fx = load('envelope/03-success-false-code-200.json');
  assert.equal(isEnvelopeOK(fx.input), fx.expect.ok);
  assert.equal(parseCode(fx.input.Code), 200);
});

test('envelope: VerifyCode 特例（Code=0 + Message）', () => {
  const fx = load('envelope/04-verify-code.json');
  assert.equal(isEnvelopeOK(fx.input), true);
  assert.equal(parseCode(fx.input.Code), 0);
  assert.equal(envelopeMessage(fx.input), '验证成功');
});

test('envelope: 负数码', () => {
  const fx = load('envelope/05-error-negative.json');
  assert.equal(isEnvelopeOK(fx.input), false);
  assert.equal(parseCode(fx.input.Code), -2);
  assert.equal(envelopeMessage(fx.input), fx.expect.message_text.trim());
});

test('envelope: reasonCode', () => {
  const fx = load('envelope/06-reason-code.json');
  assert.equal(isEnvelopeOK(fx.input), false);
  assert.equal(fx.input.reasonCode, 'PROXY_OFFLINE');
});

// ── message ─────────────────────────────────────────

test('message: 批量部分成功（字段名不统一）', () => {
  const fx = load('message/01-partial-success.json');
  const results = parseBatchResults(fx.input);
  assert.equal(results.length, fx.expect.count);
  fx.expect.items.forEach((want, i) => {
    assert.equal(results[i].to, want.to, `第 ${i} 条 to`);
    assert.equal(results[i].ok, want.ok, `第 ${i} 条 ok`);
    assert.equal(results[i].errorMessage, want.error, `第 ${i} 条 error`);
  });
});

test('message: errMgs 拼写错误兼容', () => {
  const fx = load('message/02-errmgs-typo.json');
  const results = parseBatchResults(fx.input);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].errorMessage, '上传失败');
});

test('message: 单对象返回（非数组）', () => {
  const fx = load('message/03-single-object.json');
  const results = parseBatchResults(fx.input);
  assert.equal(results.length, 1);
  assert.equal(results[0].to, 'wxid_a');
  assert.equal(results[0].ok, true);
});

// ── ws ──────────────────────────────────────────────

test('ws: 消息帧解析（含 {str} 解包与大整数）', () => {
  // 用原始帧文本（与 fixtures/ws/01-message-frame.json 的 input 一致）。
  // 必须走「文本 → dispatchFrame」真实路径：若先把 fixture 用 JSON.parse 读成对象，
  // 大整数在读取阶段就已经丢精度，测不到真实行为。
  const rawFrame = `{
    "key": "a1b2c3",
    "message": {
      "msg_id": 1751755490,
      "from_user_name": {"str": "50190590530@chatroom"},
      "to_user_name": {"str": "wxid_hvoabx1dxaci22"},
      "msg_type": 1,
      "content": {"str": "wxid_i43b65hm7dad41:\\n12345/1"},
      "create_time": 1789611963,
      "new_msg_id": 199344895681685661
    },
    "type": "message"
  }`;

  // 同时确认 fixture 用的是同一个值，避免两边漂移
  const fxRaw = fs.readFileSync(path.join(FIXTURES, 'ws/01-message-frame.json'), 'utf8');
  assert.ok(fxRaw.includes('199344895681685661'), 'fixture 应使用会丢精度的值');

  let msg = null;
  dispatchFrame(rawFrame, { onMessage: (m) => { msg = m; } });
  assert.ok(msg, '未解析出消息');
  assert.equal(msg.from, '50190590530@chatroom', '{str} 解包失败');
  assert.equal(msg.to, 'wxid_hvoabx1dxaci22');
  assert.equal(msg.type, 1);
  assert.equal(msg.newMsgId, '199344895681685661', '64 位 ID 丢精度');
  assert.equal(msg.msgId, 1751755490);
});

test('ws: 裸字符串字段 + 联系人同步', () => {
  const fx = load('ws/04-bare-string-field.json');
  const msg = parseAddMsg(fx.input.message);
  assert.ok(msg);
  assert.equal(msg.pushContent, '裸字符串内容');
  assert.equal(msg.type, 10000);
});

test('ws: unwrapString 两种形态', () => {
  assert.equal(unwrapString({ str: 'abc' }), 'abc');
  assert.equal(unwrapString('abc'), 'abc');
  assert.equal(unwrapString(null), '');
});

// ── 大整数 ──────────────────────────────────────────

test('bigint: JSON.parse 会截断，parseJSONSafe 不会', () => {
  const raw = '{"new_msg_id":199344895681685661}';
  // 危险行为演示：原生 parse 会截断末位
  const naive = JSON.parse(raw);
  assert.equal(String(naive.new_msg_id), '199344895681685660', '预期原生 parse 丢精度');
  // SDK 行为：保留原字面量
  const safe = parseJSONSafe(raw);
  assert.equal(String(safe.new_msg_id), '199344895681685661', 'parseJSONSafe 必须保留原值');
});

// ── login ───────────────────────────────────────────

test('login: 5 状态机', () => {
  const fx = load('login/01-state-machine.json');
  for (const c of fx.cases) {
    const st = LoginService.parse({ loginState: c.loginState });
    assert.equal(LoginService.isOnline(st), c.online, `${c.loginState} online`);
    assert.equal(LoginService.isTerminal(st), c.terminal, `${c.loginState} terminal`);
  }
});

// ── 错误映射 ────────────────────────────────────────

test('error: key 无效映射', () => {
  const err = errorFromEnvelope({ Code: -2, Text: '该链接不存在', Success: false }, 200, '');
  assert.ok(err instanceof APIError);
  assert.equal(err.code, CodeFailKey);
  assert.equal(err.isKeyInvalid(), true);
});
