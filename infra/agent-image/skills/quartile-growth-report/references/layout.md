# Per-grade tab layout

```
Row 1  [School] — Grade N Growth by Quartile (YYYY-YY)

Blocks in order:
  i-Ready Reading · i-Ready Math · DIBELS subtests (grade-appropriate, Raw+PR)
  · ORF Accuracy (raw) · SBA blocks · SBA Proficiency

Each block:
  title      "DIBELS 8 ORF Words Correct — Avg Raw Score & National PR Change (Fall→Spring)"
  subtitle   local-quartile + norms note (factual, one line)
  header   | Teacher1     | … | School      | District    |  | Subgroups | School      | District    |
  cols     |  Raw  PR  n  | … | Raw  PR  n  | Raw  PR  n  |  |           | Raw  PR  n  | Raw  PR  n  |
  rows       All · D (highest) · C · B · A (lowest)
  subgroups  Low Income · Non-Low Income · Special Ed · Non-Special Ed  (All level)

Bottom of tab: "School vs District — Avg National PR by Quartile" mini-tables.
Final tab: Definitions.
```

Formatting: negative changes red, positive green, n gray, `—` for n = 0.

The title must name the window actually used — "(Fall→Winter)" or
"(Fall status)" when that is what the data supported. A Fall→Winter report
labeled Fall→Spring is a wrong report, not a cosmetic slip.
