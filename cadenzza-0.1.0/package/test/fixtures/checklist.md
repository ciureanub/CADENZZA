---
owner: release
---
# Contoso Go-Live Checklist

Intro paragraph for **Northwind Traders**.

## Pre-checks

- Backups verified
  - Snapshot ID recorded
- Smoke tests green

| Check | Owner |
|---|---|
| DNS cutover | Contoso ops |
| Monitoring | SRE |

```powershell
sf project deploy start --dry-run
```
