// Vercel serverless entry point
// Wraps the Express app for Vercel's serverless function runtime
// Redeploy trigger: corrected routing + serverless DB guard
const serverless = require('serverless-http');
const app = require('../server/index');

module.exports = serverless(app, {
  // Binary types that should not be base64-encoded
  binary: ['image/*', 'application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
});
