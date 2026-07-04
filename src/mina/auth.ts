// MIoT 智能音箱插件 - Mina 认证模块
// 翻译自 Go 源码: plugins/songloft-plugin-xiaomi/pkg/mina/auth.go
// 实现小米3步登录流程：serviceLogin → serviceLoginAuth2 → 重定向获取 serviceToken

import { CookieJar } from '../utils/cookie';
import { fetchWithRedirects, fetchSync } from '../utils/http';
import { md5, generateDeviceId } from '../utils/crypto';
import {
  ACCOUNT_BASE_URL,
  MINA_SID,
  SERVICE_TOKEN_VALID_HOURS,
  MAX_REDIRECTS,
  LoginState,
  formatUserAgent,
} from './constants';
import type { LoginStateType } from './constants';
import type { XiaomiTokenInfo, ServiceTokenInfo } from '../types';
import type {
  AuthLoginResult,
  LoginStep1Data,
  CaptchaResult,
} from './models';

/**
 * MinaAuth - 小米账号认证器
 * 实现完整的3步登录流程，支持密码登录、验证码、短信验证和 passToken 刷新
 */
export class MinaAuth {
  private cookieJar: CookieJar;
  private deviceId: string;
  private userAgent: string;

  // 登录过程中的临时数据
  private captchaIck = '';
  private verifyUrl = '';
  private loginData: Record<string, unknown> | null = null;
  private username = '';
  private password = '';

  // Token 信息
  private tokenInfo: XiaomiTokenInfo;

  constructor() {
    this.cookieJar = new CookieJar();
    this.deviceId = generateDeviceId();
    this.userAgent = formatUserAgent(this.deviceId);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + SERVICE_TOKEN_VALID_HOURS * 3600 * 1000);
    this.tokenInfo = {
      user_id: '',
      device_id: this.deviceId,
      services: {},
      created_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    };
  }

  /** 获取当前的 token 信息 */
  getTokenInfo(): XiaomiTokenInfo {
    return this.tokenInfo;
  }

  /** 获取 CookieJar（用于外部访问） */
  getCookieJar(): CookieJar {
    return this.cookieJar;
  }

  /**
   * 登录（首次调用）- 获取 micoapi 的 token
   */
  async login(username: string, password: string): Promise<AuthLoginResult> {
    this.username = username;
    this.password = password;
    return this.loginService(MINA_SID);
  }

  /**
   * 登录指定服务
   */
  async loginService(sid: string): Promise<AuthLoginResult> {
    // Step 1: 获取登录签名
    const step1Result = await this.loginStep1(sid);
    if (!step1Result) {
      return { state: LoginState.FAILED, error: 'step1 failed: no response' };
    }

    this.loginData = step1Result;
    return this.loginStep2WithPassword(step1Result, '', sid);
  }

  /**
   * 使用图形验证码登录
   */
  async loginWithCaptcha(captcha: string, sid = MINA_SID): Promise<AuthLoginResult> {
    if (!this.loginData) {
      return { state: LoginState.FAILED, error: 'please call login first' };
    }
    return this.loginStep2WithPassword(this.loginData, captcha, sid);
  }

  /**
   * 使用短信/邮箱验证码完成登录
   */
  async loginWithVerifyCode(verifyCode: string, sid = MINA_SID): Promise<AuthLoginResult> {
    if (!this.verifyUrl) {
      return { state: LoginState.FAILED, error: 'no verify url, please call login first' };
    }

    // Step 1: 验证短信/邮箱验证码
    const location = await this.verifyTicket(verifyCode);
    if (!location) {
      return { state: LoginState.FAILED, error: 'verify failed: no location returned' };
    }

    // 跟随重定向链收集 passToken、userId 等 cookies
    await this.followRedirectsForCookies(location);

    // Step 2: 用 passToken + userId 调用 serviceLogin 换取 serviceToken
    const passToken = this.cookieJar.getValue('passToken');
    const userId = this.cookieJar.getValue('userId') || '';
    if (!passToken) {
      return { state: LoginState.FAILED, error: 'no passToken after verify' };
    }

    return this.exchangeServiceToken(passToken, userId, sid);
  }

  /**
   * 获取验证码图片
   */
  async getCaptchaImage(captchaUrl: string): Promise<CaptchaResult> {
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
    };

    const cookieHeader = this.cookieJar.getCookieHeader(captchaUrl);
    if (cookieHeader) {
      headers['Cookie'] = cookieHeader;
    }

    const response = await fetchSync(captchaUrl, {
      method: 'GET',
      headers,
    });

    // 收集 cookies
    const setCookieHeaders = response.headers.getSetCookie();
    if (setCookieHeaders.length > 0) {
      this.cookieJar.addFromHeaders(setCookieHeaders, captchaUrl);
    }

    // 获取 ick cookie
    const ick = this.cookieJar.getValue('ick') || '';

    // 在 QuickJS 中 body 已经是字符串（可能是 base64 或二进制字符串）
    const imageBase64 = response.text() || '';

    this.captchaIck = ick;
    return { imageBase64, ick };
  }

  /**
   * 提交短信验证码
   * @returns location URL 或空字符串
   */
  async submitSMSCode(notificationUrl: string, code: string): Promise<string> {
    this.verifyUrl = notificationUrl;
    const location = await this.verifyTicket(code);
    return location || '';
  }

  /**
   * 通过 passToken 刷新 serviceToken
   */
  async refreshByPassToken(passToken: string, userId: string, sid = MINA_SID): Promise<AuthLoginResult> {
    return this.exchangeServiceToken(passToken, userId, sid);
  }

  /**
   * serviceLogin（passToken → serviceToken）
   * 用 passToken cookie 调用 serviceLogin 获取 location，再跟随重定向获取 serviceToken
   */
  async serviceLogin(passToken: string, userId: string, sid = MINA_SID): Promise<{ serviceToken: string; ssecurity: string } | null> {
    const result = await this.exchangeServiceToken(passToken, userId, sid);
    if (result.state !== LoginState.SUCCESS || !result.tokenInfo) {
      return null;
    }

    const svcInfo = result.tokenInfo.services[sid];
    if (!svcInfo) {
      return null;
    }

    return {
      serviceToken: svcInfo.service_token,
      ssecurity: svcInfo.ssecurity,
    };
  }

  // ===== 内部方法 =====

  /**
   * Step1: 获取登录签名
   * GET https://account.xiaomi.com/pass/serviceLogin?sid={sid}&_json=true
   */
  private async loginStep1(sid: string): Promise<Record<string, unknown> | null> {
    const loginUrl = `${ACCOUNT_BASE_URL}/pass/serviceLogin?sid=${sid}&_json=true`;

    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      'Cookie': `sdkVersion=3.8.6; deviceId=${this.deviceId}`,
    };

    const cookieHeader = this.cookieJar.getCookieHeader(loginUrl);
    if (cookieHeader) {
      headers['Cookie'] = headers['Cookie'] + '; ' + cookieHeader;
    }

    const { response } = await fetchWithRedirects(loginUrl, {
      method: 'GET',
      headers,
    }, this.cookieJar, 0);

    const bodyText = response.text();
    const jsonStr = stripJsonPrefix(bodyText);

    try {
      return JSON.parse(jsonStr);
    } catch {
      return null;
    }
  }

  /**
   * Step2: 提交密码进行认证
   * POST https://account.xiaomi.com/pass/serviceLoginAuth2?_json=true
   */
  private async loginStep2WithPassword(
    auth: Record<string, unknown>,
    captcha: string,
    sid: string,
  ): Promise<AuthLoginResult> {
    const loginUrl = `${ACCOUNT_BASE_URL}/pass/serviceLoginAuth2?_json=true`;

    // 计算密码 MD5（大写）
    const passwordHash = md5(this.password).toUpperCase();

    // 构建表单数据
    const formParams: Record<string, string> = {
      user: this.username,
      hash: passwordHash,
      callback: getStringValue(auth, 'callback', ''),
      sid: getStringValue(auth, 'sid', sid),
      qs: getStringValue(auth, 'qs', ''),
      _sign: getStringValue(auth, '_sign', ''),
    };

    // 如果有验证码
    if (captcha) {
      formParams['captCode'] = captcha;
    }

    const body = encodeFormData(formParams);

    // 构建 cookies
    let cookieStr = this.cookieJar.getCookieHeader(loginUrl);
    if (captcha && this.captchaIck) {
      cookieStr = cookieStr ? cookieStr + `; ick=${this.captchaIck}` : `ick=${this.captchaIck}`;
    }

    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (cookieStr) {
      headers['Cookie'] = cookieStr;
    }

    const { response } = await fetchWithRedirects(loginUrl, {
      method: 'POST',
      headers,
      body,
    }, this.cookieJar, 0);

    const bodyText = response.text();
    const jsonStr = stripJsonPrefix(bodyText);

    let result: Record<string, unknown>;
    try {
      result = JSON.parse(jsonStr);
    } catch {
      return { state: LoginState.FAILED, error: `parse response failed: ${jsonStr.slice(0, 200)}` };
    }

    // 检查是否需要二次验证（短信/邮箱）
    if (result['notificationUrl']) {
      let notificationUrl = result['notificationUrl'] as string;
      if (!notificationUrl.startsWith('http')) {
        notificationUrl = ACCOUNT_BASE_URL + notificationUrl;
      }
      this.verifyUrl = notificationUrl;

      const verifyType = notificationUrl.includes('email') ? 'email' : 'phone';
      return {
        state: LoginState.NEED_VERIFY,
        verifyUrl: notificationUrl,
        verifyType: verifyType as 'phone' | 'email',
      };
    }

    // 检查是否需要图形验证码
    if (result['captchaUrl']) {
      let captchaUrl = result['captchaUrl'] as string;
      if (!captchaUrl.startsWith('http')) {
        captchaUrl = ACCOUNT_BASE_URL + captchaUrl;
      }

      const captchaResult = await this.getCaptchaImage(captchaUrl);
      return {
        state: LoginState.NEED_CAPTCHA,
        captchaImage: captchaResult.imageBase64,
      };
    }

    // 检查是否有 location（登录成功）
    const location = result['location'] as string | undefined;
    if (!location) {
      const code = result['code'];
      const desc = result['description'];
      return {
        state: LoginState.FAILED,
        error: `login failed, code: ${code}, desc: ${desc}, sid: ${sid}`,
      };
    }

    // 保存认证信息到 cookie jar（通过 cookieJar 已自动完成）
    const ssecurity = getStringValue(result, 'ssecurity', '');
    // 从原始 JSON 字符串提取 nonce，避免 JSON.parse 大整数精度丢失
    const nonce = extractBigIntField(jsonStr, 'nonce') || getStringValue(result, 'nonce', '');
    const userId = getStringValue(result, 'userId', '');

    // 计算 clientSign
    const clientSign = computeClientSign(nonce, ssecurity);
    console.log(`[loginStep2] clientSign generated nonce_present=${!!nonce} ssecurity_present=${!!ssecurity}`);
    const locationWithSign = appendQueryParams(location, {
      _userIdNeedEncrypt: 'true',
      clientSign,
    });

    // Step 3: 获取 serviceToken
    const step3Error = await this.loginStep3(locationWithSign, sid, ssecurity);
    if (step3Error) {
      return { state: LoginState.FAILED, error: `step3 failed: ${step3Error}` };
    }

    // 设置 userId
    if (!this.tokenInfo.user_id && userId) {
      this.tokenInfo.user_id = userId;
    }

    return { state: LoginState.SUCCESS, tokenInfo: this.tokenInfo };
  }

  /**
   * Step3: 跟随重定向获取 serviceToken
   * 访问 location URL，自动跟随重定向，从 Cookie 中收集 serviceToken
   * 携带登录过程中积累的 cookies（deviceId、sdkVersion 等），与 WASM 版本保持一致
   */
  private async loginStep3(location: string, sid: string, ssecurityFromStep2 = ''): Promise<string | null> {
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      'Content-Type': 'application/x-www-form-urlencoded',
    };

    console.log(`[loginStep3] STS request sid=${sid} url=${sanitizeSTSUrlForLog(location)} header_keys=${Object.keys(headers).join(',')}`);

    // 使用 fetchWithRedirects 自动跟随重定向链并携带 cookieJar 中的 cookies
    // 这与 WASM 版本的行为一致（WASM 版使用 autoRedirectClient + 全部 cookies）
    const { response: finalResponse } = await fetchWithRedirects(location, {
      method: 'GET',
      headers,
    }, this.cookieJar, MAX_REDIRECTS);

    const setCookieNames = getSetCookieNames(finalResponse.headers.getSetCookie());
    console.log(`[loginStep3] STS response sid=${sid} status=${finalResponse.status} set_cookie_names=${setCookieNames.join(',') || '-'} jar_cookie_names=${this.cookieJar.getNames().join(',') || '-'}`);

    // 优先从当前 STS 响应头取 serviceToken，避免 CookieJar 里其他 sid 的同名 cookie 干扰。
    const serviceToken = getSetCookieValue(finalResponse.headers.getSetCookie(), 'serviceToken')
      || this.cookieJar.getValue('serviceToken')
      || '';
    const userId = this.cookieJar.getValue('userId') || '';
    const ssecurity = this.cookieJar.getValue('ssecurity') || ssecurityFromStep2;

    if (!serviceToken) {
      let bodyText = '';
      try { bodyText = finalResponse.text(); } catch { /* ignore */ }
      return `failed to get serviceToken, status: ${finalResponse.status}, body: ${bodyText.slice(0, 200)}`;
    }

    // 保存到 tokenInfo
    if (!this.tokenInfo.user_id && userId) {
      this.tokenInfo.user_id = userId;
    }

    this.tokenInfo.services[sid] = {
      service_token: serviceToken,
      ssecurity: ssecurity,
      expires_at: Date.now() + SERVICE_TOKEN_VALID_HOURS * 3600 * 1000,
    };

    return null; // success
  }

  /**
   * 用 passToken 通过 serviceLogin 换取指定服务的 serviceToken
   */
  private async exchangeServiceToken(passToken: string, userId: string, sid: string): Promise<AuthLoginResult> {
    const serviceLoginUrl = `${ACCOUNT_BASE_URL}/pass/serviceLogin?sid=${sid}&_json=true`;

    // 构建 cookies
    const cookieParts: string[] = [
      `passToken=${passToken}`,
      `userId=${userId}`,
      `deviceId=${this.deviceId}`,
      `sdkVersion=3.8.6`,
    ];

    const cUserId = this.cookieJar.getValue('cUserId');
    if (cUserId) {
      cookieParts.push(`cUserId=${cUserId}`);
    }

    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      'Cookie': cookieParts.join('; '),
    };

    const { response } = await fetchWithRedirects(serviceLoginUrl, {
      method: 'GET',
      headers,
    }, this.cookieJar, 0);

    const bodyText = response.text();
    const jsonStr = stripJsonPrefix(bodyText);

    let loginData: Record<string, unknown>;
    try {
      loginData = JSON.parse(jsonStr);
    } catch {
      return { state: LoginState.FAILED, error: `parse serviceLogin response failed: ${jsonStr.slice(0, 200)}` };
    }

    // 检查返回码
    const code = Number(loginData['code'] || 0);
    if (code !== 0) {
      const desc = getStringValue(loginData, 'desc', 'unknown');
      return { state: LoginState.FAILED, error: `serviceLogin for ${sid} failed: code=${code}, desc=${desc}` };
    }

    // 获取 location URL 和 ssecurity
    const location = getStringValue(loginData, 'location', '');
    const ssecurity = getStringValue(loginData, 'ssecurity', '');

    if (!location) {
      return { state: LoginState.FAILED, error: `serviceLogin for ${sid} returned no location URL` };
    }

    // 更新 userId
    const newUserId = getStringValue(loginData, 'userId', '');
    if (newUserId) {
      this.tokenInfo.user_id = newUserId;
    }

    // 从原始 JSON 字符串提取 nonce，避免 JSON.parse 大整数精度丢失
    const nonce = extractBigIntField(jsonStr, 'nonce') || getStringValue(loginData, 'nonce', '');
    const clientSign = computeClientSign(nonce, ssecurity);
    console.log(`[exchangeServiceToken] clientSign generated sid=${sid} nonce_present=${!!nonce} ssecurity_present=${!!ssecurity}`);
    const locationWithSign = appendQueryParams(location, {
      _userIdNeedEncrypt: 'true',
      clientSign,
    });

    // Step 3: 访问 location URL 获取 serviceToken
    const step3Error = await this.loginStep3(locationWithSign, sid, ssecurity);
    if (step3Error) {
      return { state: LoginState.FAILED, error: `step3 failed: ${step3Error}` };
    }

    if (!this.tokenInfo.user_id && userId) {
      this.tokenInfo.user_id = userId;
    }

    return { state: LoginState.SUCCESS, tokenInfo: this.tokenInfo };
  }

  /**
   * 验证短信/邮箱验证码
   */
  private async verifyTicket(ticket: string): Promise<string | null> {
    // 如果是身份验证类型的URL，先获取 identity_session
    if (this.verifyUrl.includes('/fe/service/identity/authStart')) {
      await this.checkIdentityList();
    }

    // 根据 verifyURL 判断是手机还是邮箱
    let verifyAPI = '/identity/auth/verifyPhone';
    let flag = '4';
    if (this.verifyUrl.includes('email')) {
      verifyAPI = '/identity/auth/verifyEmail';
      flag = '8';
    }

    const apiUrl = `${ACCOUNT_BASE_URL}${verifyAPI}?_dc=${Date.now()}`;

    const formParams: Record<string, string> = {
      ticket,
      trust: 'true',
      _json: 'true',
      _flag: flag,
    };

    const body = encodeFormData(formParams);
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      'Content-Type': 'application/x-www-form-urlencoded',
    };

    const cookieStr = this.cookieJar.getCookieHeader(apiUrl);
    if (cookieStr) {
      headers['Cookie'] = cookieStr;
    }

    const { response } = await fetchWithRedirects(apiUrl, {
      method: 'POST',
      headers,
      body,
    }, this.cookieJar, 0);

    const bodyText = response.text();
    const jsonStr = stripJsonPrefix(bodyText);

    try {
      const result = JSON.parse(jsonStr);
      if (result.code !== 0) {
        return null;
      }
      return result.location || null;
    } catch {
      return null;
    }
  }

  /**
   * 检查身份验证列表并获取 identity_session
   */
  private async checkIdentityList(): Promise<void> {
    const listUrl = this.verifyUrl.replace('/fe/service/identity/authStart', '/identity/list');

    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
    };

    const cookieStr = this.cookieJar.getCookieHeader(listUrl);
    if (cookieStr) {
      headers['Cookie'] = cookieStr;
    }

    try {
      await fetchWithRedirects(listUrl, { method: 'GET', headers }, this.cookieJar, 0);
    } catch {
      // non-fatal, ignore
    }
  }

  /**
   * 跟随重定向链收集 cookies（特别是 passToken、userId）
   */
  private async followRedirectsForCookies(location: string): Promise<void> {
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
      'Content-Type': 'application/x-www-form-urlencoded',
    };

    try {
      await fetchWithRedirects(location, { method: 'GET', headers }, this.cookieJar, MAX_REDIRECTS);
    } catch {
      // non-fatal, passToken might already be obtained
    }
  }
}

// ===== 工具函数 =====

/**
 * 去掉小米API响应的 JSON 前缀 "&&&START&&&"
 */
function stripJsonPrefix(body: string): string {
  return body.replace('&&&START&&&', '').trim();
}

/**
 * 从原始 JSON 字符串中用正则提取大整数字段值（作为字符串）
 * 解决 JavaScript Number 精度限制（最大 2^53）导致 JSON.parse() 丢失大整数精度的问题
 * 例如 nonce: 1610098522385872896 会被 JSON.parse 四舍五入为 1610098522385873000
 */
function extractBigIntField(jsonStr: string, field: string): string {
  const regex = new RegExp('"' + field + '"\\s*:\\s*(\\d+)');
  const match = jsonStr.match(regex);
  return match ? match[1] : '';
}

/**
 * 从 map 中获取字符串值（兼容数字类型的 userId 等）
 */
function getStringValue(obj: Record<string, unknown>, key: string, defaultValue: string): string {
  const v = obj[key];
  if (v === undefined || v === null) return defaultValue;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(Math.floor(v));
  return String(v);
}

function appendQueryParams(url: string, params: Record<string, string>): string {
  const sep = url.includes('?') ? '&' : '?';
  const body = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `${url}${sep}${body}`;
}

function sanitizeSTSUrlForLog(url: string): string {
  const queryIdx = url.indexOf('?');
  const base = queryIdx >= 0 ? url.slice(0, queryIdx) : url;
  const query = queryIdx >= 0 ? url.slice(queryIdx + 1) : '';
  const keys = query
    ? query.split('&').map(part => safeDecodeURIComponent(part.split('=')[0] || '')).filter(Boolean)
    : [];
  return keys.length > 0 ? `${base}?keys=${keys.join(',')}` : base;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function getSetCookieNames(setCookieHeaders: string[]): string[] {
  const names = setCookieHeaders
    .map(header => header.split('=', 1)[0]?.trim() || '')
    .filter(Boolean);
  return Array.from(new Set(names)).sort();
}

function getSetCookieValue(setCookieHeaders: string[], name: string): string {
  for (const header of setCookieHeaders) {
    const firstPart = header.split(';', 1)[0] || '';
    const eqIdx = firstPart.indexOf('=');
    if (eqIdx <= 0) continue;
    if (firstPart.slice(0, eqIdx).trim() === name) {
      return firstPart.slice(eqIdx + 1).trim();
    }
  }
  return '';
}

/**
 * 编码表单数据为 URL-encoded 格式
 */
function encodeFormData(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/**
 * 计算 clientSign = base64(sha1("nonce={nonce}&{ssecurity}"))
 * QuickJS 环境下使用 crypto.md5 不够，需要 SHA1
 * 使用简易 SHA1 实现
 */
function computeClientSign(nonce: string, ssecurity: string): string {
  const input = `nonce=${nonce}&${ssecurity}`;
  // 优先用宿主原生 SHA1（QuickJS 解释执行下纯 JS SHA1 慢）；老运行时（无
  // crypto.sha1）自动回退到下方纯 JS 实现，保证兼容。
  const nativeSha1 = (globalThis as { crypto?: { sha1?(s: string): string } }).crypto?.sha1;
  if (typeof nativeSha1 === 'function') {
    const hex = nativeSha1(input);
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return btoa(String.fromCharCode(...bytes));
  }
  const hash = sha1(input);
  return btoa(String.fromCharCode(...hash));
}

/**
 * SHA1 哈希实现（纯 JS，适用于 QuickJS 环境）
 */
function sha1(message: string): Uint8Array {
  // 将字符串转为字节数组
  const msgBytes: number[] = [];
  for (let i = 0; i < message.length; i++) {
    const code = message.charCodeAt(i);
    if (code < 0x80) {
      msgBytes.push(code);
    } else if (code < 0x800) {
      msgBytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else {
      msgBytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }

  // Pre-processing
  const msgLen = msgBytes.length;
  const bitLen = msgLen * 8;

  // Padding
  msgBytes.push(0x80);
  while ((msgBytes.length % 64) !== 56) {
    msgBytes.push(0);
  }
  // Append original length in bits as 64-bit big-endian
  // Note: JavaScript >>> operates on 32-bit integers and reduces shift by mod 32,
  // so we must explicitly write high 32 bits as 0 (message length always < 2^32 bits)
  msgBytes.push(0, 0, 0, 0); // high 32 bits (always 0 for our use case)
  msgBytes.push((bitLen >>> 24) & 0xff);
  msgBytes.push((bitLen >>> 16) & 0xff);
  msgBytes.push((bitLen >>> 8) & 0xff);
  msgBytes.push(bitLen & 0xff);

  // Initialize hash values
  let h0 = 0x67452301;
  let h1 = 0xEFCDAB89;
  let h2 = 0x98BADCFE;
  let h3 = 0x10325476;
  let h4 = 0xC3D2E1F0;

  // Process each 512-bit chunk
  for (let offset = 0; offset < msgBytes.length; offset += 64) {
    const w: number[] = new Array(80);

    for (let i = 0; i < 16; i++) {
      w[i] = (msgBytes[offset + i * 4] << 24) |
              (msgBytes[offset + i * 4 + 1] << 16) |
              (msgBytes[offset + i * 4 + 2] << 8) |
              (msgBytes[offset + i * 4 + 3]);
    }

    for (let i = 16; i < 80; i++) {
      w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4;

    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) {
        f = (b & c) | ((~b) & d);
        k = 0x5A827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ED9EBA1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8F1BBCDC;
      } else {
        f = b ^ c ^ d;
        k = 0xCA62C1D6;
      }

      const temp = (rotl(a, 5) + f + e + k + w[i]) | 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }

  // Produce the final hash value (160 bits = 20 bytes)
  const result = new Uint8Array(20);
  for (let i = 0; i < 4; i++) {
    result[i] = (h0 >>> (24 - i * 8)) & 0xff;
    result[i + 4] = (h1 >>> (24 - i * 8)) & 0xff;
    result[i + 8] = (h2 >>> (24 - i * 8)) & 0xff;
    result[i + 12] = (h3 >>> (24 - i * 8)) & 0xff;
    result[i + 16] = (h4 >>> (24 - i * 8)) & 0xff;
  }

  return result;
}

/** 循环左移 */
function rotl(n: number, s: number): number {
  return ((n << s) | (n >>> (32 - s))) | 0;
}

/**
 * ArrayBuffer 转 Base64
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * 从 Response 中获取 Set-Cookie 头
 */
function getSetCookieHeaders(response: Response): string[] {
  if (typeof (response.headers as any).getSetCookie === 'function') {
    return (response.headers as any).getSetCookie() as string[];
  }
  const raw = response.headers.get('set-cookie');
  return raw ? [raw] : [];
}
