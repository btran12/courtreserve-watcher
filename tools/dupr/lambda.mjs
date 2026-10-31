// AWS Lambda adapter (Function URL / API Gateway v2 event) around the shared core in app.mjs.
//
// CloudFormation deploys the build produced by build-template.mjs, which concatenates app.mjs +
// this file into one CommonJS source. The lookup page is hosted separately; this adapter only
// serves the API routes.
import { createEngine, createRouter } from './app.mjs';

// One engine (and cache) per warm container.
let router = null;
function getRouter() {
  if (!router) {
    router = createRouter(createEngine(), {
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
