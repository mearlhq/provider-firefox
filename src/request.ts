import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, isAbsolute } from 'node:path';
import { CookieJar, domainMatch, pathMatch } from 'tough-cookie';
import {
  assertSafeSendRequestMultipartValue,
  assertSendRequestBase64FileLimits,
  assertSendRequestFileCount,
  assertSendRequestFileLimits,
  decodeSendRequestBase64Bytes,
  filterCookiesForUrl,
  findSendRequestHeaderName,
  getSendRequestBodyFile,
  getSendRequestSourceHeaders,
  inferSendRequestContentType,
  isBinarySendRequestContentType,
  isSecureCookieUrl,
  serializeRequestCookies,
  type SendRequestFile,
  type SendRequestParams,
} from '@mearl/browser-core';
import type { BiDiConnection } from './bidi.js';
import { bytesValue } from './values.js';

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);

interface StoredCookie {
  name: string;
  value: unknown;
  domain: string;
  path: string;
  secure?: boolean;
}

function headerMap(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (name.toLowerCase() !== 'set-cookie') result[name] = value;
  });
  return result;
}

async function browserCookies(connection: BiDiConnection, url: string, deadline?: number) {
  const result = await connection.send<{ cookies?: StoredCookie[] }>('storage.getCookies', {}, deadline);
  return filterCookiesForUrl(
    (result.cookies ?? []).map(cookie => ({
      name: cookie.name,
      value: bytesValue(cookie.value),
      domain: cookie.domain,
      path: cookie.path,
    })),
    url,
  );
}

async function syncCookies(connection: BiDiConnection, url: string, headers: string[], deadline?: number) {
  if (!headers.length) return undefined;
  const jar = new CookieJar(undefined, { prefixSecurity: 'strict' });
  const result = { updatedCount: 0, rejectedCount: 0, failedCount: 0 };
  const secureSource = isSecureCookieUrl(new URL(url));
  let stored: Array<{ name: string; domain: string; path: string; secure?: boolean }> | undefined;
  for (const header of headers) {
    const now = new Date();
    const cookie = await jar.setCookie(header, url, { now, ignoreError: true });
    if (
      !cookie ||
      (cookie.secure && !secureSource) ||
      (cookie.sameSite === 'none' && !cookie.secure) ||
      cookie.extensions?.some((attribute: string) => /^partitioned(?:\s|=|$)/i.test(attribute))
    ) {
      result.rejectedCount += 1;
      continue;
    }
    const expires = cookie.expiryTime(now);
    try {
      if (!secureSource) {
        stored ??= (await connection.send<{ cookies?: StoredCookie[] }>('storage.getCookies', {}, deadline)).cookies ?? [];
        if (stored.some(existing =>
          existing.secure &&
          existing.name === cookie.key &&
          (domainMatch(existing.domain.replace(/^\./, ''), cookie.domain ?? '') || domainMatch(cookie.domain ?? '', existing.domain.replace(/^\./, ''))) &&
          pathMatch(cookie.path ?? '/', existing.path),
        )) {
          result.rejectedCount += 1;
          continue;
        }
      }
      const sameSite = cookie.sameSite ? cookie.sameSite[0]!.toUpperCase() + cookie.sameSite.slice(1) : undefined;
      await connection.send('storage.setCookie', {
        cookie: {
          name: cookie.key,
          value: { type: 'string', value: cookie.value },
          ...(cookie.hostOnly ? {} : { domain: `.${cookie.domain}` }),
          path: cookie.path ?? '/',
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          ...(sameSite ? { sameSite } : {}),
          ...(expires !== undefined && expires !== Infinity ? { expiry: Math.max(1, Math.floor(expires / 1000)) } : {}),
        },
      }, deadline);
      result.updatedCount += 1;
    } catch {
      result.failedCount += 1;
    }
  }
  return result;
}

async function fileBytes(file: SendRequestFile, index: number): Promise<{ filename: string; contentType: string; content: Buffer }> {
  const hasPath = typeof file.filePath === 'string' && file.filePath.length > 0;
  const hasBase64 = typeof file.base64 === 'string';
  if (hasPath === hasBase64) throw new Error(`files[${index}] must provide exactly one of filePath or base64`);
  let content: Buffer;
  let filename: string;
  if (hasPath) {
    if (!isAbsolute(file.filePath!)) throw new Error(`files[${index}].filePath must be an absolute path`);
    content = await readFile(file.filePath!);
    filename = file.filename || basename(file.filePath!);
  } else {
    filename = file.filename || '';
    if (!filename) throw new Error(`files[${index}].filename is required when base64 is used`);
    content = Buffer.from(decodeSendRequestBase64Bytes(file.base64, `files[${index}].base64`));
  }
  return {
    filename: assertSafeSendRequestMultipartValue(filename, `files[${index}].filename`),
    contentType: file.contentType?.trim()
      ? assertSafeSendRequestMultipartValue(file.contentType.trim(), `files[${index}].contentType`)
      : inferSendRequestContentType(filename),
    content,
  };
}

async function multipart(data: SendRequestParams): Promise<{ contentType: string; body: Buffer }> {
  const boundary = `----mearl${randomBytes(12).toString('hex')}`;
  const chunks: Buffer[] = [];
  const append = (headers: string, content: Buffer | string) => {
    chunks.push(Buffer.from(`--${boundary}\r\n${headers}\r\n\r\n`));
    chunks.push(typeof content === 'string' ? Buffer.from(content) : content);
    chunks.push(Buffer.from('\r\n'));
  };
  for (const [name, value] of Object.entries(data.formData ?? {})) {
    const text = assertSafeSendRequestMultipartValue(String(value), `formData.${name}`);
    append(`Content-Disposition: form-data; name="${name.replace(/"/g, '%22')}"`, text);
  }
  const files = data.files ?? [];
  assertSendRequestFileCount(files.length);
  const encodedFiles = await Promise.all(files.map((file, index) => fileBytes(file, index)));
  assertSendRequestFileLimits(encodedFiles.map(file => file.content.byteLength));
  assertSendRequestBase64FileLimits(files.flatMap((file, index) => file.base64 ? [encodedFiles[index]!.content.byteLength] : []));
  for (const [index, file] of encodedFiles.entries()) {
    const fieldName = assertSafeSendRequestMultipartValue(files[index]?.fieldName, `files[${index}].fieldName`).replace(/"/g, '%22');
    append(
      `Content-Disposition: form-data; name="${fieldName}"; filename="${file.filename.replace(/"/g, '%22')}"\r\nContent-Type: ${file.contentType}`,
      file.content,
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(chunks) };
}

/** Send one request with the Firefox cookie jar, matching the CDP send_request result. */
export async function sendFirefoxRequest(connection: BiDiConnection, data: SendRequestParams, deadline?: number) {
  const { url, method = 'GET', headers = {}, params, body, formData, files, withCookies = true, responseType = 'auto', timeout = 30000 } = data ?? {};
  if (!url || typeof url !== 'string' || !url.trim()) throw new Error('Invalid url: url must be a non-empty string');
  const normalizedMethod = method.toUpperCase();
  if (!ALLOWED_METHODS.has(normalizedMethod)) throw new Error(`Invalid method: ${method}. Allowed: ${[...ALLOWED_METHODS].join(', ')}`);
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('timeout must be a positive number');
  const target = new URL(url);
  for (const [key, value] of Object.entries(params ?? {})) target.searchParams.set(key, String(value));
  const requestHeaders: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:153.0) Gecko/20100101 Firefox/153.0',
    ...headers,
  };
  const source = getSendRequestSourceHeaders(target, headers);
  if (source.referer) requestHeaders.Referer = source.referer;
  else delete requestHeaders.Referer;
  if (source.origin) requestHeaders.Origin = source.origin;
  else delete requestHeaders.Origin;
  const cookies = withCookies ? await browserCookies(connection, target.toString(), deadline) : [];
  const cookieHeader = serializeRequestCookies(cookies);
  if (cookieHeader) requestHeaders.Cookie = cookieHeader;
  const xsrf = cookies.find(cookie => cookie.name === 'XSRF-TOKEN')?.value;
  if (xsrf && !findSendRequestHeaderName(requestHeaders, 'x-xsrf-token')) requestHeaders['X-XSRF-TOKEN'] = xsrf;

  let requestBody: BodyInit | undefined;
  const bodyFile = getSendRequestBodyFile(data);
  if (bodyFile) {
    const content = bodyFile.base64
      ? decodeSendRequestBase64Bytes(bodyFile.base64, 'bodyFile.base64')
      : new Uint8Array(await readFile(bodyFile.filePath!));
    requestBody = content;
    if (!findSendRequestHeaderName(requestHeaders, 'content-type')) requestHeaders['Content-Type'] = bodyFile.contentType || 'application/octet-stream';
  } else if (formData !== undefined || (files && files.length)) {
    if (body !== undefined && body !== null) throw new Error('body cannot be combined with formData or files');
    if (normalizedMethod === 'GET' || normalizedMethod === 'HEAD') throw new Error(`${normalizedMethod} requests cannot use formData or files`);
    if (findSendRequestHeaderName(requestHeaders, 'content-type')) {
      throw new Error('Do not set Content-Type when using formData or files; Mearl sets the boundary');
    }
    const encoded = await multipart(data);
    requestBody = new Uint8Array(encoded.body);
    requestHeaders['Content-Type'] = encoded.contentType;
  } else if (body !== undefined && body !== null && !['GET', 'HEAD'].includes(normalizedMethod)) {
    requestBody = typeof body === 'string' ? body : JSON.stringify(body);
    if (!findSendRequestHeaderName(requestHeaders, 'content-type')) {
      requestHeaders['Content-Type'] = typeof body === 'string' ? 'text/plain' : 'application/json';
    }
  }

  const budget = deadline === undefined ? timeout : Math.min(timeout, Math.max(1, deadline - Date.now()));
  const response = await fetch(target, { method: normalizedMethod, headers: requestHeaders, body: requestBody, redirect: 'manual', signal: AbortSignal.timeout(budget) });
  const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  const cookieSync = withCookies ? await syncCookies(connection, response.url || target.href, setCookies, deadline) : undefined;
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  let responseBody: unknown;
  let bodyType: 'json' | 'text' | 'base64';
  if (responseType === 'auto' && isBinarySendRequestContentType(contentType)) {
    responseBody = buffer.toString('base64');
    bodyType = 'base64';
  } else {
    const text = buffer.toString('utf8');
    const trimmed = text.trimStart();
    const shouldParse = responseType === 'json' || (responseType === 'auto' && (contentType.includes('application/json') || trimmed.startsWith('{') || trimmed.startsWith('[')));
    if (shouldParse) {
      try {
        responseBody = JSON.parse(text);
        bodyType = 'json';
      } catch (error) {
        if (responseType === 'json') throw new Error('send_request expected a JSON response', { cause: error });
        responseBody = text;
        bodyType = 'text';
      }
    } else {
      responseBody = text;
      bodyType = 'text';
    }
  }
  return {
    success: true,
    status: response.status,
    statusText: response.statusText,
    headers: headerMap(response.headers),
    body: responseBody,
    bodyType,
    attachedCookieCount: cookies.length,
    ...(cookieSync && (cookieSync.updatedCount || cookieSync.rejectedCount || cookieSync.failedCount) ? { cookieSync } : {}),
  };
}
