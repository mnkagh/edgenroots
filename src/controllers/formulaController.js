'use strict';

const { asyncHandler } = require('../middleware/errorHandler');

function services(req) {
  return req.app.locals.services;
}

const formulaController = {
  createOrChange: asyncHandler(async (req, res) => {
    const isChange = Boolean(req.body.uuid);
    const saved = await services(req).formulaService.createOrChange(req.body);
    res.status(isChange ? 200 : 201).json({ data: saved });
  }),

  list: asyncHandler(async (req, res) => {
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;
    const data = await services(req).formulaService.list({ status });
    res.json({ data });
  }),

  getByUuid: asyncHandler(async (req, res) => {
    const data = await services(req).formulaService.getByUuid(req.params.uuid);
    res.json({ data });
  }),

  history: asyncHandler(async (req, res) => {
    const data = await services(req).formulaService.history(req.params.uuid);
    res.json({ data });
  }),

  impact: asyncHandler(async (req, res) => {
    const data = await services(req).formulaService.impact(req.params.uuid);
    res.json({ data });
  }),

  deactivate: asyncHandler(async (req, res) => {
    const data = await services(req).formulaService.deactivate(req.params.uuid, req.body);
    res.json({ data });
  }),

  rollback: asyncHandler(async (req, res) => {
    const data = await services(req).formulaService.rollback(req.params.uuid, req.body);
    res.json({ data });
  }),

  preview: asyncHandler(async (req, res) => {
    const data = await services(req).previewService.preview(req.body);
    res.json({ data });
  }),

  previewBulk: asyncHandler(async (req, res) => {
    const data = await services(req).previewService.previewBulk(req.body);
    res.json({ data });
  }),
};

module.exports = { formulaController };
