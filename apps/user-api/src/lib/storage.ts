import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '@lifeplanner/shared-utils';
import { env } from '../config/env.js';
import { logger } from './logger.js';

export interface StoredObject {
  storageKey: string;
  url: string;
  sizeBytes: number;
  mimeType: string;
  checksum: string;
}

const extensionFor = (mimeType: string): string => {
  const map: Record<string, string> = {
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/wav': 'wav',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  };
  return map[mimeType.split(';')[0].trim()] ?? 'bin';
};

/**
 * Cloudflare R2 speaks the S3 API. Rather than pull in the full AWS SDK we sign
 * requests with SigV4 directly — it is one function and keeps the dependency
 * surface small for what is a single PUT.
 */
async function putToR2(key: string, body: Buffer, mimeType: string): Promise<void> {
  const host = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const url = `https://${host}/${env.R2_BUCKET}/${key}`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = crypto.createHash('sha256').update(body).digest('hex');

  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    'PUT',
    `/${env.R2_BUCKET}/${key}`,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const hmac = (key: crypto.BinaryLike | Buffer, data: string) =>
    crypto.createHmac('sha256', key).update(data).digest();

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${env.R2_SECRET_ACCESS_KEY}`, dateStamp), 'auto'), 's3'),
    'aws4_request',
  );
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `AWS4-HMAC-SHA256 Credential=${env.R2_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      'Content-Type': mimeType,
      'Content-Length': String(body.length),
    },
    body: new Uint8Array(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    logger.error({ status: response.status, text: text.slice(0, 300) }, 'R2 upload failed');
    throw AppError.internal('Could not store the uploaded file');
  }
}

async function putLocal(key: string, body: Buffer): Promise<void> {
  const target = path.join(env.LOCAL_STORAGE_DIR, key);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, body);
}

/**
 * Uploads a buffer and returns the row data for a MediaAsset. Falls back to the
 * local driver when R2 credentials are absent, so uploads work in dev without a
 * Cloudflare account.
 */
export async function putObject(
  prefix: string,
  body: Buffer,
  mimeType: string,
): Promise<StoredObject> {
  const checksum = crypto.createHash('sha256').update(body).digest('hex');
  const key = `${prefix}/${crypto.randomUUID()}.${extensionFor(mimeType)}`;

  if (env.STORAGE_DRIVER === 'r2' && env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID) {
    await putToR2(key, body, mimeType);
    const base = env.R2_PUBLIC_BASE_URL || `https://${env.R2_BUCKET}.r2.dev`;
    return { storageKey: key, url: `${base}/${key}`, sizeBytes: body.length, mimeType, checksum };
  }

  await putLocal(key, body);
  return {
    storageKey: key,
    url: `${env.PUBLIC_BASE_URL}/media/${key}`,
    sizeBytes: body.length,
    mimeType,
    checksum,
  };
}

export async function deleteObject(storageKey: string): Promise<void> {
  if (env.STORAGE_DRIVER !== 'r2') {
    await fs.rm(path.join(env.LOCAL_STORAGE_DIR, storageKey), { force: true }).catch(() => undefined);
    return;
  }
  // R2 deletes are deferred to a lifecycle rule; the row is soft-deleted here.
  logger.debug({ storageKey }, 'Object marked for deletion');
}

/** Decodes a base64 payload, rejecting anything over the configured ceiling. */
export function decodeBase64(input: string, maxBytes: number): Buffer {
  const cleaned = input.includes(',') ? input.slice(input.indexOf(',') + 1) : input;
  // Cheap length check before allocating the buffer.
  if (Math.ceil((cleaned.length * 3) / 4) > maxBytes) {
    throw AppError.badRequest(`File exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit`);
  }
  const buffer = Buffer.from(cleaned, 'base64');
  if (buffer.length === 0) throw AppError.badRequest('The uploaded file is empty');
  if (buffer.length > maxBytes) {
    throw AppError.badRequest(`File exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit`);
  }
  return buffer;
}
