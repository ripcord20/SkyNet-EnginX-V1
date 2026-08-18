'use strict';

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { demoGuard } = require('../middleware/demoGuard');
const { apiAllowNocArea } = require('../middleware/nocAccess');
const ctrl = require('../controllers/NetworkHealthController');

router.get('/status', authenticate, demoGuard, apiAllowNocArea, ctrl.status);
router.post('/config', authenticate, demoGuard, apiAllowNocArea, ctrl.saveConfig);
router.post('/poll', authenticate, demoGuard, apiAllowNocArea, ctrl.pollNow);
router.get('/overview', authenticate, demoGuard, apiAllowNocArea, ctrl.overview);
router.get('/devices/:id/history', authenticate, demoGuard, apiAllowNocArea, ctrl.history);

module.exports = router;
