# SkyNet-EnginX-V1

ISP CRM (FlayNet) — Device Management, billing, isolir, dan RADIUS AAA.

## RADIUS

Menu **RADIUS AAA** (`/monitoring/radius`) memakai skema MySQL FreeRADIUS
(`nas`, `radcheck`, `radreply`, `radusergroup`, `radgroupreply`, `radacct`).
Arahkan FreeRADIUS ke database CRM, lalu di MikroTik:

```
/radius add service=ppp address=<IP-CRM> secret=<shared-secret>
/ppp aaa set use-radius=yes
```
