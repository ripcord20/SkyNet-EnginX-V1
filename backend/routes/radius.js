const express = require('express');
const router = express.Router();
const { logActivity } = require('../middleware/activityLogger');
const ctrl = require('../controllers/RadiusController');

router.get('/stats',              ctrl.stats);
router.get('/settings',           ctrl.getSettings);
router.put('/settings',           logActivity('update', 'radius'), ctrl.saveSettings);

router.get('/nas',                ctrl.listNas);
router.post('/nas',               logActivity('create', 'radius_nas'), ctrl.createNas);
router.post('/nas/sync-devices',  ctrl.syncNas);
router.put('/nas/:id',            logActivity('update', 'radius_nas'), ctrl.updateNas);
router.delete('/nas/:id',         logActivity('delete', 'radius_nas'), ctrl.deleteNas);

router.get('/users',              ctrl.listUsers);
router.post('/users',             logActivity('create', 'radius_user'), ctrl.createUser);
router.post('/users/sync-customers', ctrl.syncCustomers);
router.get('/users/:username',    ctrl.showUser);
router.put('/users/:username',    logActivity('update', 'radius_user'), ctrl.updateUser);
router.delete('/users/:username', logActivity('delete', 'radius_user'), ctrl.deleteUser);
router.post('/users/:username/enable',  ctrl.enableUser);
router.post('/users/:username/disable', ctrl.disableUser);

router.get('/profiles',           ctrl.listProfiles);
router.post('/profiles',          logActivity('create', 'radius_profile'), ctrl.saveProfile);
router.delete('/profiles/:groupname', logActivity('delete', 'radius_profile'), ctrl.deleteProfile);

router.get('/sessions',           ctrl.listSessions);

module.exports = router;
