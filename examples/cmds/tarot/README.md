# Tarot Example Command

Copy this folder into your `${DATA_DIR}/cmds/tarot` directory to enable the example tarot command.

Text usage:

```text
/lilac:tarot
/lilac:tarot mode=past-present-future Please give me advice on my career change.
/lilac:tarot mode=situation-obstacle-advice Help me think through this relationship.
```

Discord slash usage:

```text
/lilac tarot mode:mind-body-spirit prompt:Help me understand why I feel stuck.
```

Supported modes:

- `single`
- `past-present-future`
- `situation-obstacle-advice`
- `mind-body-spirit`

The command returns structured card data plus `assistant_guidance` so the model can turn the draw into a grounded reading.
