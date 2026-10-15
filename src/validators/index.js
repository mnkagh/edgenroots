'use strict';

const { z } = require('zod');
const AppError = require('../errors/AppError');

const identifier = z
  .string()
  .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, 'must be a valid identifier (letters, digits, underscore)');

const dateTime = z.string().refine((v) => !Number.isNaN(Date.parse(v)), {
  message: 'must be an ISO-8601 date-time',
});

const createOrChangeSchema = z.object({
  uuid: z.string().uuid().optional(),
  name: identifier,
  formula: z.string().min(1, 'is required'),
  description: z.string().max(500).nullable().optional(),
  createdBy: z.string().min(1).max(128).default('system'),
  version: z.number().int().positive().optional(),
  force: z.boolean().optional().default(false),
  sampleData: z.record(z.any()).optional(),
});

const deactivateSchema = z.object({
  version: z.number().int().positive(),
  createdBy: z.string().min(1).max(128).default('system'),
  force: z.boolean().optional().default(false),
});

const rollbackSchema = z.object({
  toVersion: z.number().int().positive(),
  version: z.number().int().positive(),
  createdBy: z.string().min(1).max(128).default('system'),
  force: z.boolean().optional().default(false),
});

const previewSchema = z.object({
  record: z.record(z.any()),
  formulaUuids: z.array(z.string().uuid()).optional(),
  asOf: dateTime.optional(),
});

function buildBulkSchema(maxRecords) {
  return z.object({
    records: z
      .array(z.record(z.any()))
      .min(1, 'at least one record is required')
      .max(maxRecords, `at most ${maxRecords} records are allowed`),
    formulaUuids: z.array(z.string().uuid()).optional(),
    asOf: dateTime.optional(),
  });
}

/**
 * Validate a request body against a zod schema and replace req.body with the
 * parsed value (defaults applied, unknown keys stripped). Failures become a
 * 400 with readable per-field detail.
 */
function validate(schema) {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => ({
        field: i.path.join('.') || '(body)',
        message: i.message,
      }));
      return next(
        AppError.badRequest('Request body failed validation.', 'VALIDATION_ERROR', { issues })
      );
    }
    req.body = parsed.data;
    return next();
  };
}

function validateUuidParam(paramName = 'uuid') {
  return (req, res, next) => {
    const value = req.params[paramName];
    if (!/^[0-9a-fA-F-]{36}$/.test(value || '')) {
      return next(
        AppError.badRequest(`"${paramName}" must be a UUID.`, 'INVALID_UUID', { param: paramName })
      );
    }
    return next();
  };
}

module.exports = {
  createOrChangeSchema,
  deactivateSchema,
  rollbackSchema,
  previewSchema,
  buildBulkSchema,
  validate,
  validateUuidParam,
};
