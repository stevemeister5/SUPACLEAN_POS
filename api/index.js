// Vercel entry point.
//
// Vercel's Node runtime invokes the exported handler with a real (req, res),
// so the Express app is exported directly. Wrapping it in `serverless-http`
// (which expects an AWS Lambda event/context) makes Express answer a mock
// request/response, so nothing is ever written to the real response and every
// request hangs until the function times out.
const app = require('../server/index');

// vercel.json rewrites /api/* to this file. If the router forwards the rewrite
// destination instead of the original URL, restore the /api/* prefix so Express
// routing still matches.
const REWRITE_PATH = '/api/index.js';

let loggedFirstRequest = false;

module.exports = (req, res) => {
  if (typeof req.url === 'string' && req.url.startsWith(REWRITE_PATH)) {
    req.url = `/api${req.url.slice(REWRITE_PATH.length)}`;
  }

  if (!loggedFirstRequest) {
    loggedFirstRequest = true;
    console.log(`API function first request on this instance: ${req.method} ${req.url}`);
  }

  return app(req, res);
};

