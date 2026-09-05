# Labels

A label flag on a write creates a missing label, prints `created label 'X' (#color) · recolor: …` on
stderr, and continues.

- `--label` and `--labels` replace the whole set and print what they dropped; `--add-label` and
  `--remove-label` edit it in place. The two styles cannot be combined in one command.
- Both forms accept several names: repeat the flag or comma-separate the names, so
  `--add-label 'area:cli,kind:bug'` is two labels. The server keeps that parseable: a label name may
  not contain a comma (422), and whitespace is normalized, so `'area:   cli'` is stored and matched as
  `area: cli`. A name the CLI can say is always a name it can say again.
- Removals and filters are strict. `--remove-label` and `issue list --label` reject a name the project
  does not have; only writes create one. `issue list --label a --label b` matches either label.
- Auto-created labels get a color derived from their name; recolor with the command in the notice.
- Creating needs the admin role. A writer-only token is told so, with the command to hand over.

```bash
todou label list -p <proj>
todou label create <name> [--color '#hex']
todou label edit <name> [--name N] [--color '#hex']
todou label delete <name>
```
