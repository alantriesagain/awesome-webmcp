# @widecode/screen

The screen a plugin-made terminal app draws: `contributions.ts` is what a plugin puts on it (a `Column` with its view and width, a `Panel`, a tab of a tab column with its rows in a `LineView` and its info row, a `BandPart`, a strip of the status band, and a `SegmentDef`, a status segment drawing from a `SegmentContext`, held by name in `Segments`); `screen.ts` is `ScreenController`, the light controller holding the columns, tabs and strips, the active column, the status message (`tell`, cleared after a while), the clipboard, the focus, and what the shell reads to lay out (`layout`, `tabs` signals) and fires for plugins (`messageChanged`); `column-view.ts` is `<wc-column>`, the bordered column element a shell's template names, in the palette's colors.

Tests: widecode's screen, columns and statusbar tests prove it over the whole app.
