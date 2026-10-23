// Lambda (Node 20+) behind a Function URL. Env: BUCKET, TOKEN, KEY (optional, default courtreserve-watcher/state.json)
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { timingSafeEqual } from 'node:crypto';

const s3 = new S3Client({});
const MAX_BYTES = 2 * 1024 * 1024;

const same = (a, b) => {
  const x = Buffer.from(a || ''), y = Buffer.from(b || '');
  return x.length === y.length && timingSafeEqual(x, y);
};

export const handler = async (event) => {
  const token = event.headers?.['x-watcher-token'];
  if (!process.env.TOKEN || !same(token, process.env.TOKEN)) return { statusCode: 401, body: 'unauthorized' };
  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString() : event.body || '';
  if (raw.length > MAX_BYTES) return { statusCode: 413, body: 'too large' };
  let data;
  try { data = JSON.parse(raw); } catch { return { statusCode: 400, body: 'bad json' }; }
  if (!data || typeof data.snapshots !== 'object' || !Array.isArray(data.log)) return { statusCode: 400, body: 'bad shape' };

  await s3.send(new PutObjectCommand({
    Bucket: process.env.BUCKET,
    Key: process.env.KEY || 'courtreserve-watcher/state.json',
    Body: JSON.stringify({ ...data, uploadedAt: Date.now() }),
    ContentType: 'application/json',
    CacheControl: 'no-cache',
  }));
  return { statusCode: 200, body: 'ok' };
};
