// MIoT 智能音箱插件 - Cookie管理工具
// 轻量级 CookieJar 实现，用于小米登录流程中跨域名跟踪Cookie

/** Cookie对象 */
export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;    // Unix timestamp ms
  secure: boolean;
  httpOnly: boolean;
}

/**
 * 解析Set-Cookie响应头
 * @param setCookieHeaders - Set-Cookie头的值数组
 * @param requestUrl - 请求的URL（用于推断domain和path）
 */
export function parseCookies(setCookieHeaders: string[], requestUrl: string): Cookie[] {
  const cookies: Cookie[] = [];
  const urlDomain = extractDomain(requestUrl);
  const urlPath = extractPath(requestUrl);

  for (const header of setCookieHeaders) {
    const cookie = parseSingleCookie(header, urlDomain, urlPath);
    if (cookie) {
      cookies.push(cookie);
    }
  }
  return cookies;
}

/**
 * 解析单个Set-Cookie头
 */
function parseSingleCookie(header: string, defaultDomain: string, defaultPath: string): Cookie | null {
  const parts = header.split(';').map(p => p.trim());
  if (parts.length === 0) return null;

  // 第一部分是 name=value
  const firstPart = parts[0];
  const eqIdx = firstPart.indexOf('=');
  if (eqIdx === -1) return null;

  const name = firstPart.slice(0, eqIdx).trim();
  const value = firstPart.slice(eqIdx + 1).trim();

  if (!name) return null;

  const cookie: Cookie = {
    name,
    value,
    domain: defaultDomain,
    path: defaultPath,
    secure: false,
    httpOnly: false,
  };

  // 解析属性
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const attrEq = part.indexOf('=');
    let attrName: string;
    let attrValue: string;

    if (attrEq === -1) {
      attrName = part.toLowerCase();
      attrValue = '';
    } else {
      attrName = part.slice(0, attrEq).trim().toLowerCase();
      attrValue = part.slice(attrEq + 1).trim();
    }

    switch (attrName) {
      case 'domain':
        // 去掉前导点
        cookie.domain = attrValue.startsWith('.') ? attrValue.slice(1) : attrValue;
        break;
      case 'path':
        cookie.path = attrValue || '/';
        break;
      case 'expires':
        cookie.expires = parseExpires(attrValue);
        break;
      case 'max-age': {
        const maxAge = parseInt(attrValue, 10);
        if (!isNaN(maxAge)) {
          cookie.expires = Date.now() + maxAge * 1000;
        }
        break;
      }
      case 'secure':
        cookie.secure = true;
        break;
      case 'httponly':
        cookie.httpOnly = true;
        break;
    }
  }

  return cookie;
}

/**
 * 解析Expires日期字符串为时间戳
 */
function parseExpires(dateStr: string): number | undefined {
  if (!dateStr) return undefined;
  const ts = Date.parse(dateStr);
  return isNaN(ts) ? undefined : ts;
}

/**
 * 构建Cookie请求头
 * @param cookies - Cookie数组
 * @param url - 目标请求URL
 * @returns Cookie头字符串（如 "name1=value1; name2=value2"）
 */
export function buildCookieHeader(cookies: Cookie[], url: string): string {
  const domain = extractDomain(url);
  const path = extractPath(url);
  const isSecure = url.startsWith('https');
  const now = Date.now();

  const matching = cookies.filter(c => {
    // 检查过期
    if (c.expires !== undefined && c.expires < now) return false;
    // 检查安全标志
    if (c.secure && !isSecure) return false;
    // 检查域名匹配（允许子域名）
    if (!domainMatches(domain, c.domain)) return false;
    // 检查路径匹配
    if (!pathMatches(path, c.path)) return false;
    return true;
  });

  return matching.map(c => `${c.name}=${c.value}`).join('; ');
}

/**
 * 域名匹配：请求域名是目标域名或其子域名
 */
function domainMatches(requestDomain: string, cookieDomain: string): boolean {
  if (requestDomain === cookieDomain) return true;
  // 子域名匹配
  return requestDomain.endsWith('.' + cookieDomain);
}

/**
 * 路径匹配
 */
function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (requestPath.startsWith(cookiePath)) {
    // cookiePath以/结尾，或者requestPath在cookiePath之后紧跟/
    return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
  }
  return false;
}

/**
 * 从URL中提取域名
 */
function extractDomain(url: string): string {
  try {
    // 简单解析，不依赖URL对象（QuickJS可能不支持）
    let host = url;
    const protoIdx = host.indexOf('://');
    if (protoIdx !== -1) {
      host = host.slice(protoIdx + 3);
    }
    const slashIdx = host.indexOf('/');
    if (slashIdx !== -1) {
      host = host.slice(0, slashIdx);
    }
    // 移除端口
    const colonIdx = host.lastIndexOf(':');
    if (colonIdx !== -1) {
      host = host.slice(0, colonIdx);
    }
    return host.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 从URL中提取路径
 */
function extractPath(url: string): string {
  try {
    let rest = url;
    const protoIdx = rest.indexOf('://');
    if (protoIdx !== -1) {
      rest = rest.slice(protoIdx + 3);
    }
    const slashIdx = rest.indexOf('/');
    if (slashIdx === -1) return '/';
    const path = rest.slice(slashIdx);
    // 去掉query和fragment
    const qIdx = path.indexOf('?');
    if (qIdx !== -1) return path.slice(0, qIdx);
    const hIdx = path.indexOf('#');
    if (hIdx !== -1) return path.slice(0, hIdx);
    return path;
  } catch {
    return '/';
  }
}

/**
 * CookieJar - 维护跨域名Cookie存储
 * 用于小米登录流程中跨多个域名（account.xiaomi.com, api.mina.mi.com等）跟踪Cookie
 */
export class CookieJar {
  private cookies: Cookie[] = [];

  /**
   * 添加Cookie（从Set-Cookie响应头解析）
   * 同名同域同路径的Cookie会被覆盖
   */
  add(newCookies: Cookie[]): void {
    for (const nc of newCookies) {
      // 如果值为空或已删除标记，移除已存在的同名Cookie
      if (nc.value === '' || (nc.expires !== undefined && nc.expires < Date.now())) {
        this.cookies = this.cookies.filter(
          c => !(c.name === nc.name && c.domain === nc.domain && c.path === nc.path)
        );
        continue;
      }
      // 覆盖同名同域同路径的Cookie
      const idx = this.cookies.findIndex(
        c => c.name === nc.name && c.domain === nc.domain && c.path === nc.path
      );
      if (idx !== -1) {
        this.cookies[idx] = nc;
      } else {
        this.cookies.push(nc);
      }
    }
  }

  /**
   * 从Set-Cookie响应头中解析并添加Cookie
   */
  addFromHeaders(setCookieHeaders: string[], requestUrl: string): void {
    const parsed = parseCookies(setCookieHeaders, requestUrl);
    this.add(parsed);
  }

  /**
   * 获取匹配目标URL的Cookie请求头
   */
  getCookieHeader(url: string): string {
    return buildCookieHeader(this.cookies, url);
  }

  /**
   * 获取指定域名下的所有Cookie
   */
  getByDomain(domain: string): Cookie[] {
    return this.cookies.filter(c => domainMatches(domain, c.domain));
  }

  /**
   * 获取当前 Cookie 名称（仅用于诊断日志，不暴露值）
   */
  getNames(domain?: string): string[] {
    const names = this.cookies
      .filter(c => !domain || domainMatches(domain, c.domain))
      .map(c => c.name);
    return Array.from(new Set(names)).sort();
  }

  /**
   * 获取指定名称的Cookie值
   */
  getValue(name: string, domain?: string): string | undefined {
    const found = this.cookies.find(c => {
      if (c.name !== name) return false;
      if (domain && !domainMatches(domain, c.domain)) return false;
      return true;
    });
    return found?.value;
  }

  /**
   * 清除所有Cookie
   */
  clear(): void {
    this.cookies = [];
  }

  /**
   * 清除指定域名的Cookie
   */
  clearDomain(domain: string): void {
    this.cookies = this.cookies.filter(c => c.domain !== domain);
  }

  /**
   * 清除过期Cookie
   */
  purgeExpired(): void {
    const now = Date.now();
    this.cookies = this.cookies.filter(c => c.expires === undefined || c.expires >= now);
  }

  /**
   * 导出所有Cookie（用于持久化）
   */
  export(): Cookie[] {
    return [...this.cookies];
  }

  /**
   * 导入Cookie（从持久化数据恢复）
   */
  import(cookies: Cookie[]): void {
    this.cookies = [...cookies];
  }

  /**
   * 当前存储的Cookie数量
   */
  get size(): number {
    return this.cookies.length;
  }
}
