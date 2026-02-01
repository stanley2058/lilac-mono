## apply_patch (agent tool)

This tool applies multi-file edits using a structured patch format. It is intended
for changes that would be brittle with line-based edits.

### Tool input

The agent calls `apply_patch` with:

```json
{
  "patchText": "*** Begin Patch\n...\n*** End Patch",
  "cwd": "/optional/base/dir"
}
```

- `patchText` is required.
- `cwd` is optional. Relative file paths inside the patch are resolved against
  this directory (defaults to the agent tool root).

### Patch format

The patch must start with `*** Begin Patch` and end with `*** End Patch`.

Operations are expressed as one or more sections:

- Add a new file:

```text
*** Add File: path/to/file.txt
+first line
+second line
```

- Delete a file:

```text
*** Delete File: path/to/file.txt
```

- Update (edit) a file:

```text
*** Update File: path/to/file.txt
@@ optional anchor line
 context line (starts with a space)
-removed line
+added line
```

- Rename while updating:

```text
*** Update File: old/path.txt
*** Move to: new/path.txt
@@
 ...
```

Update hunks use blocks that begin with `@@`.

- A context anchor line can be written as `@@ something`.
- Within a block:
  - lines starting with ` ` are context lines (must match existing file)
  - lines starting with `-` are deletions
  - lines starting with `+` are insertions
- `*** End of File` inside a block forces the match to occur at the end.

### Notes / limitations

- Deletes refuse to remove directories.
- The implementation uses a small amount of fuzzy matching (trim/whitespace and
  basic unicode punctuation normalization) to handle copy/paste artifacts.
