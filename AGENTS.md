# AGENTS.md

## Cursor Cloud specific instructions

This repo is a single **Node.js/Express + EJS** web app — "SKYNET/FLAYNET CRM", a web-based
ISP management system (customers, billing/isolir, devices/MikroTik, RADIUS, monitoring).
The backend (`backend/`) also renders the EJS frontend (`frontend/`), so there is **one
service**, not a separate frontend server. It requires a **MySQL/MariaDB** database.

The startup update script only runs `npm install`. Everything below (database server,
schema import, `.env`) is **not** handled automatically and must be done once per fresh VM.

### Running the app

- Start (dev, hot-reload via nodemon): `npm run dev` — listens on `http://localhost:3002`
  (`APP_PORT`, default 3002). Standard scripts live in `package.json`.
- Tests: there is **no** `npm test` script and **no linter configured**. Run test files
  directly, e.g. `node backend/test/sanitize.test.js`. All files under `backend/test/*.test.js`
  are self-contained (they stub network deps) and do **not** need the database.

### Required `.env` (repo root, git-ignored)

`backend/server.js` loads `/workspace/.env`. Minimum for local dev:

```
APP_ENV=development
NODE_ENV=development
APP_PORT=3002
APP_URL=http://localhost:3002
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=isp_netops
DB_USER=skynet
DB_PASS=skynet
JWT_SECRET=dev_jwt_secret_change_me_0123456789
JWT_REFRESH_SECRET=dev_jwt_refresh_secret_change_me_0123456789
JWT_EXPIRY=30d
```

All third-party integrations (MikroTik, SMTP, WhatsApp/Baileys, Telegram, GenieACS,
Firebase, payment gateways) are optional and stay disabled when their env vars are blank —
the server still boots and logs warnings for them. That is expected in dev.

### Database bootstrap (the important, non-obvious part)

**Do NOT rely on `sequelize.sync()` against an empty database — it fails.** In development
`server.js` calls `sequelize.sync({ alter: false })`, but on a truly empty DB it errors out
(FK ordering: `customers` references `packages`/`devices`/`infrastructure_points`; and the
`ResellerTransaction` model defines an index on `createdAt` that maps to a non-existent
column). The app expects a **pre-existing schema**. Import the bundled SQL dump instead.

The dump ships in the repo inside `SKYNET CRM FULL SC - INETmedia.zip` at
`FLAYNET CRM FULL SC - INETmedia/DATABASE (Import to Your MySQL DB)/flaynet.sql`. It
contains the full schema plus seed roles/permissions and superadmin users (customers/
packages start empty).

One-time bootstrap on a fresh VM (MariaDB is a system dependency, not installed by the
update script — install it with apt if missing: `mariadb-server mariadb-client`):

```
# 1) start the DB server (no systemd in the sandbox)
sudo mkdir -p /var/lib/mysql /var/run/mysqld && sudo chown -R mysql:mysql /var/lib/mysql /var/run/mysqld
[ -d /var/lib/mysql/mysql ] || sudo mariadb-install-db --user=mysql --datadir=/var/lib/mysql
sudo mysqld_safe --datadir=/var/lib/mysql >/tmp/mysqld.log 2>&1 &   # wait until `sudo mysqladmin ping` says alive

# 2) create db + app user matching .env
sudo mysql -e "CREATE DATABASE IF NOT EXISTS isp_netops CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'skynet'@'127.0.0.1' IDENTIFIED BY 'skynet';
CREATE USER IF NOT EXISTS 'skynet'@'localhost' IDENTIFIED BY 'skynet';
GRANT ALL PRIVILEGES ON isp_netops.* TO 'skynet'@'127.0.0.1';
GRANT ALL PRIVILEGES ON isp_netops.* TO 'skynet'@'localhost'; FLUSH PRIVILEGES;"

# 3) extract + import the dump. Use FOREIGN_KEY_CHECKS=0 (the dump has one orphan FK row).
unzip -o -j "SKYNET CRM FULL SC - INETmedia.zip" \
  "FLAYNET CRM FULL SC - INETmedia/DATABASE (Import to Your MySQL DB)/flaynet.sql" -d /tmp/skynet_db
( echo "SET FOREIGN_KEY_CHECKS=0;"; cat /tmp/skynet_db/flaynet.sql ) | mysql -h127.0.0.1 -uskynet -pskynet isp_netops

# 4) satisfy the reseller_transactions sync index bug so `npm run dev` boots cleanly
mysql -h127.0.0.1 -uskynet -pskynet isp_netops \
  -e "CREATE INDEX reseller_transactions_created_at ON reseller_transactions (created_at);"
```

Gotchas during import (all safe to ignore):
- The **last** statement (`CREATE EVENT purge_traffic_data`) fails with `ERROR 1227 ... need
  SUPER` under a non-root user. It is a background cleanup event; the rest of the schema/data
  imports fine. Everything before it succeeds.
- If a previous partial `sequelize.sync()` created tables, drop and recreate the database
  before importing, otherwise you get `Table 'devices' already exists`.

### Logging in

After importing, superadmin accounts exist (e.g. `admin@flaynet.com`) but the seeded bcrypt
hashes are unknown. Reset one to a known password before logging in:

```
HASH=$(node -e "console.log(require('bcryptjs').hashSync('Admin123!',12))")
mysql -h127.0.0.1 -uskynet -pskynet isp_netops \
  -e "UPDATE users SET password='$HASH', is_active=1 WHERE email='admin@flaynet.com';"
```

Then log in at `http://localhost:3002/login` with `admin@flaynet.com` / `Admin123!`
(superadmin role bypasses per-permission checks).
