// AWS Lambda adapter (Function URL / API Gateway v2 event) around the shared core in app.mjs.
//
// CloudFormation deploys the build produced by build-template.mjs, which concatenates app.mjs +
// this file into one CommonJS source and injects the page as INDEX_HTML_B64. When run directly
// (node lambda.mjs / tests) it reads index.html from disk instead.
import { createEngine, createRouter } from './app.mjs';

const HTML = typeof INDEX_HTML_B64 === 'string' && INDEX_HTML_B64
  ? Buffer.from(INDEX_HTML_B64, 'base64').toString('utf8')
  : '';

// One engine (and cache) per warm container.
let router = null;
function getRouter() {
  if (!router) {
    router = createRouter(createEngine(), {
      html: HTML,
      token: process.env.DUPR_API_TOKEN || '',
      origin: process.env.ALLOWED_ORIGIN || '*',
    });
  }
  return router;
}

export const handler = async (event = {}) => {
  const method = event.requestContext?.http?.method || event.httpMethod || 'GET';
  const rawPath = event.rawPath || event.path || '/';
  const pathname = rawPath.replace(/\/+$/, '') || '/';
  const query = event.queryStringParameters || {};
  const headers = event.headers || {};
  let body = event.body || '';
  if (event.isBase64Encoded && body) body = Buffer.from(body, 'base64').toString('utf8');

  return getRouter()(method, pathname, query, body, headers);
};
