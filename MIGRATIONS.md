# MIGRATIONS.md

This file documents config-version changes in a form that is readable by both humans and agents.

## Core Config

Lilac parses `core-config.yaml` through a versioned parser into one universal runtime config shape. The app only consumes the universal shape.

Rules:

- New generated configs include `configVersion`.
- Existing configs without `configVersion` are treated as `configVersion: 1`.
- Lilac does not auto-upgrade config files at startup.
- Versioned parsers own defaults for their version.
- New behavior-changing defaults only apply to configs on the version that introduced them.
- If a newer field cannot be represented safely in an older version, that field requires the newer `configVersion`.

## v1

`configVersion: 1` is the initial versioned config contract and matches the defaults used before config versioning was introduced.

To make an existing implicit v1 config explicit, add:

```yaml
configVersion: 1
```

No field migrations are required for v1.
