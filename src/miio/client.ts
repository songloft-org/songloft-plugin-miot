// MIoT 智能音箱插件 - MiIO / MIoT RPC 客户端

/// <reference types="@songloft/plugin-sdk" />

import { ungzip } from 'pako';
import { httpFetch } from '../utils/http';
import type { XiaomiTokenInfo } from '../types';
import {
  MIIO_API_BASE_URL,
  MIIO_USER_AGENT,
  XIAOMI_IO_SID,
} from '../mina/constants';

export interface MiIOResponse {
  code: number;
  message?: string;
  result?: unknown;
  [key: string]: unknown;
}

/**
 * MiIOClient 实现 miservice.MiIOService 中 TTS command 需要的最小子集。
 */
export class MiIOClient {
  private tokenInfo: XiaomiTokenInfo;

  constructor(tokenInfo: XiaomiTokenInfo) {
    this.tokenInfo = tokenInfo;
  }

  /**
   * 调用 MIoT action 播放 TTS。
   *
   * xiaomusic 的 "5-3 你好" 形式等价于：
   * POST /miotspec/action { did, siid: 5, aiid: 3, in: ["你好"] }
   */
  async textToSpeechByCommand(did: string, ttsCommand: string, text: string): Promise<boolean> {
    const [siid, aiid] = parseTTSCommand(ttsCommand);
    if (!did || siid <= 0 || aiid <= 0) {
      songloft.log.warn(`[MiIOClient] invalid TTS command did=${did || ''} command=${ttsCommand}`);
      return false;
    }

    const safeText = text.replace(/ /g, ',');
    songloft.log.info(`[MiIOClient] TTS command start did=${did} siid=${siid} aiid=${aiid} text_length=${text.length}`);

    const result = await this.miotAction(did, siid, aiid, [safeText]);
    const innerCode = result && typeof result === 'object' && 'code' in result
      ? Number((result as Record<string, unknown>).code)
      : 0;
    const ok = innerCode === 0;

    if (ok) {
      songloft.log.info(`[MiIOClient] TTS command success did=${did} siid=${siid} aiid=${aiid} result=${summarizeForLog(result)}`);
    } else {
      songloft.log.warn(`[MiIOClient] TTS command non-zero code=${innerCode} did=${did} result=${summarizeForLog(result)}`);
    }
    return ok;
  }

  private async miotAction(did: string, siid: number, aiid: number, args: unknown[]): Promise<unknown | null> {
    return this.miioRequest('/miotspec/action', {
      params: {
        did,
        siid,
        aiid,
        in: args,
      },
    });
  }

  private async miioRequest(uri: string, data: unknown): Promise<unknown | null> {
    const service = this.tokenInfo.services[XIAOMI_IO_SID];
    if (!service || !service.service_token || !service.ssecurity) {
      songloft.log.warn('[MiIOClient] missing xiaomiio service token');
      return null;
    }

    const method = 'POST';
    const encoded = encodeMiIOT(method, uri, data, service.ssecurity);
    const body = encodeFormData(encoded);
    const headers: Record<string, string> = {
      'User-Agent': MIIO_USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
      'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2',
      'miot-accept-encoding': 'GZIP',
      'miot-encrypt-algorithm': 'ENCRYPT-RC4',
      'Cookie': [
        'countryCode=CN',
        'locale=zh_CN',
        'timezone=GMT+08:00',
        'timezone_id=Asia/Shanghai',
        `userId=${this.tokenInfo.user_id}`,
        `PassportDeviceId=${this.tokenInfo.device_id}`,
        `serviceToken=${service.service_token}`,
        `yetAnotherServiceToken=${service.service_token}`,
      ].join('; '),
    };

    let response;
    try {
      response = await httpFetch(`${MIIO_API_BASE_URL}${uri}`, {
        method,
        headers,
        body,
      });
    } catch (e) {
      songloft.log.warn(`[MiIOClient] request failed uri=${uri}: ${String(e)}`);
      return null;
    }

    const text = response.text();
    const gzip = (response.headers.get('miot-content-encoding') || '').toUpperCase() === 'GZIP';
    songloft.log.info(`[MiIOClient] HTTP status=${response.status} uri=${uri} encrypted_length=${text.length} gzip=${gzip}`);
    if (response.status !== 200) {
      return null;
    }

    let parsed: MiIOResponse | null;
    try {
      parsed = decodeMiIOT(service.ssecurity, encoded._nonce, text, gzip) as MiIOResponse | null;
    } catch (e) {
      songloft.log.warn(`[MiIOClient] decode response failed uri=${uri}: ${String(e)}`);
      return null;
    }

    if (!parsed || typeof parsed !== 'object') {
      songloft.log.warn(`[MiIOClient] empty decoded response uri=${uri}`);
      return null;
    }

    songloft.log.info(`[MiIOClient] decoded response uri=${uri} response=${summarizeForLog(parsed)}`);

    if ('code' in parsed && Number(parsed.code) !== 0) {
      songloft.log.warn(`[MiIOClient] non-zero outer code=${parsed.code} message=${parsed.message || ''}`);
      return null;
    }

    if (!('result' in parsed)) {
      songloft.log.warn(`[MiIOClient] response missing result uri=${uri}`);
      return null;
    }

    return parsed.result ?? null;
  }
}

function parseTTSCommand(command: string): [number, number] {
  const [siidText, aiidText] = command.split('-', 2);
  return [Number(siidText || 0), Number(aiidText || 1)];
}

function encodeMiIOT(method: string, uri: string, data: unknown, ssecurity: string): Record<string, string> & { _nonce: string } {
  const dataText = typeof data === 'string' ? data : JSON.stringify(data);
  const nonce = generateMiIOTNonce();
  const snonce = signNonce(ssecurity, nonce);
  const plain: Record<string, string> = {
    data: dataText,
  };
  plain.rc4_hash__ = rc4Hash(method, uri, plain, snonce);

  const dataHex = utf8ToHex(plain.data);
  const hashHex = utf8ToHex(plain.rc4_hash__);
  const encryptedHex = rc4Drop1024(base64ToHex(snonce), dataHex + hashHex);
  const encrypted: Record<string, string> = {
    data: hexToBase64(encryptedHex.slice(0, dataHex.length)),
    rc4_hash__: hexToBase64(encryptedHex.slice(dataHex.length)),
  };
  encrypted.signature = rc4Hash(method, uri, {
    data: encrypted.data,
    rc4_hash__: encrypted.rc4_hash__,
  }, snonce);
  encrypted._nonce = nonce;
  encrypted.ssecurity = ssecurity;
  return encrypted as Record<string, string> & { _nonce: string };
}

function decodeMiIOT(ssecurity: string, nonce: string, data: string, gzip: boolean): unknown | null {
  const keyHex = base64ToHex(signNonce(ssecurity, nonce));
  const decryptedHex = rc4Drop1024(keyHex, base64ToHex(data));
  let text: string;
  if (gzip) {
    text = ungzip(new Uint8Array(hexToBytes(decryptedHex)), { to: 'string' }) as string;
  } else {
    text = hexToUtf8(decryptedHex);
  }
  return JSON.parse(text);
}

function signNonce(ssecurity: string, nonce: string): string {
  const digestHex = sha256BytesHex(base64ToHex(ssecurity) + base64ToHex(nonce));
  return hexToBase64(digestHex);
}

function generateMiIOTNonce(): string {
  return hexToBase64(randomHexBytes(12));
}

function rc4Hash(method: string, uri: string, data: Record<string, string>, snonce: string): string {
  const parts: string[] = [];
  if (method) {
    parts.push(method.toUpperCase());
  }
  if (uri) {
    parts.push(uri);
  }
  for (const key of Object.keys(data)) {
    parts.push(`${key}=${data[key]}`);
  }
  parts.push(snonce);
  return sha1Base64(parts.join('&'));
}

function rc4Drop1024(keyHex: string, dataHex: string): string {
  const dropHex = '00'.repeat(1024);
  return rc4Hex(keyHex, dropHex + dataHex).slice(dropHex.length);
}

function encodeFormData(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function randomHexBytes(size: number): string {
  const go = globalThis as any;
  if (typeof go.__go_crypto_random_bytes === 'function') {
    return go.__go_crypto_random_bytes(size);
  }
  return go.crypto.randomBytes(size).toString('hex');
}

function sha256BytesHex(dataHex: string): string {
  const go = globalThis as any;
  if (typeof go.__go_crypto_sha256_bytes === 'function') {
    return go.__go_crypto_sha256_bytes(dataHex);
  }
  return go.crypto.sha256Bytes({ _hex: dataHex }).toString('hex');
}

function sha1Base64(value: string): string {
  const go = globalThis as any;
  const hex = typeof go.__go_crypto_sha1 === 'function'
    ? go.__go_crypto_sha1(value)
    : go.crypto.sha1(value);
  return hexToBase64(hex);
}

function rc4Hex(keyHex: string, dataHex: string): string {
  const go = globalThis as any;
  if (typeof go.__go_crypto_rc4 === 'function') {
    return go.__go_crypto_rc4(keyHex, dataHex);
  }
  return go.crypto.rc4({ _hex: keyHex }, { _hex: dataHex }).toString('hex');
}

function utf8ToHex(value: string): string {
  return (globalThis as any).__go_buffer_from(value, 'utf8');
}

function hexToUtf8(value: string): string {
  return (globalThis as any).__go_buffer_to_string(value, 'utf8');
}

function base64ToHex(value: string): string {
  return (globalThis as any).__go_buffer_from(value, 'base64');
}

function hexToBase64(value: string): string {
  return (globalThis as any).__go_buffer_to_string(value, 'base64');
}

function hexToBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    out.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return out;
}

function summarizeForLog(value: unknown, maxLength = 600): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > maxLength ? text.slice(0, maxLength) + '...(truncated)' : text;
  } catch {
    return String(value);
  }
}
