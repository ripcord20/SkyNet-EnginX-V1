'use strict';

/**
 * Cache User+Role+Permission untuk authenticate().
 * Setiap buka menu adalah full page load yang sebelumnya selalu
 * `User.findByPk` + include role/permissions — itu yang bikin pindah
 * modul terasa berat di VPS.
 *
 * TTL pendek (20s): role/aktif berubah paling lambat 20 detik.
 */

const TTL_MS = 20000;
const cache = new Map(); // userId -> { user, exp }

function getCachedAuthUser(userId) {
  const id = Number(userId);
  if (!Number.isFinite(id)) return null;
  const hit = cache.get(id);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    cache.delete(id);
    return null;
  }
  return hit.user;
}

function setCachedAuthUser(userId, user, ttlMs = TTL_MS) {
  const id = Number(userId);
  if (!Number.isFinite(id) || !user) return;
  cache.set(id, { user, exp: Date.now() + Number(ttlMs) });
}

function invalidateAuthUserCache(userId) {
  if (userId == null) {
    cache.clear();
    return;
  }
  cache.delete(Number(userId));
}

async function loadAuthUser(userId) {
  const cached = getCachedAuthUser(userId);
  if (cached) return cached;
  const { User, Role, Permission } = require('../models');
  const user = await User.findByPk(userId, {
    include: [{
      model: Role,
      as: 'role',
      include: [{
        model: Permission,
        as: 'permissions',
        through: { attributes: [] },
      }],
    }],
  });
  if (user && user.is_active) setCachedAuthUser(userId, user);
  return user;
}

module.exports = {
  TTL_MS,
  getCachedAuthUser,
  setCachedAuthUser,
  invalidateAuthUserCache,
  loadAuthUser,
};
