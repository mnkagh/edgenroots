'use strict';

const AppError = require('../errors/AppError');

/** Wrap an async route handler so rejected promises reach the error handler. */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/**
 * Terminal error middleware. Produces the consistent envelope used by every
 * endpoint. Unknown/programming errors become 500 without leaking internals.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }

  // Duplicate key caught at the DB level (e.g. a concurrency race).
  if (err && err.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({
      error: {
        code: 'CONFLICT',
        message: 'The record changed while you were editing it.',
        details: null,
      },
    });
  }

  // eslint-disable-next-line no-console
  console.error('[unhandled]', err);
  return res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error', details: null },
  });
}

function notFoundHandler(req, res) {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.originalUrl} not found`,
      details: null,
    },
  });
}

module.exports = { asyncHandler, errorHandler, notFoundHandler };
