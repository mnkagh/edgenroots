'use strict';

/**
 * Single error type used across every layer. The HTTP layer turns it into the
 * one consistent error envelope: { error: { code, message, details } }.
 */
class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', details = null) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.expected = true;
  }

  static badRequest(message, code = 'BAD_REQUEST', details = null) {
    return new AppError(message, 400, code, details);
  }

  static notFound(message, code = 'NOT_FOUND', details = null) {
    return new AppError(message, 404, code, details);
  }

  static conflict(message, code = 'CONFLICT', details = null) {
    return new AppError(message, 409, code, details);
  }
}

module.exports = AppError;
