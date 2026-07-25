# Skill: PPT Generation (HTML-first workflow)

Generate professional PowerPoint presentations using an HTML-first approach for rapid iteration, then convert to .pptx for final delivery.

## When to Use

- User asks to create a presentation / slide deck / PPT
- User wants to convert content (docs, data, diagrams) into slides
- User wants to iterate on slide design quickly

## Workflow

### Phase 1 — Content & Story Design

1. Gather user's raw material (data, diagrams, notes, context)
2. Design story arc (e.g., Problem → Evidence → Solution → Demo → Roadmap)
3. Outline slide-by-slide content with user approval before generating

### Phase 2 — HTML Preview (Fast Iteration)

1. Generate a standalone HTML file with all slides as sections
2. Use CSS for layout, colors, typography — no external dependencies
3. Open in browser for instant preview
4. Iterate with user on content, layout, ordering until approved

Key HTML patterns:
- One `<section>` per slide
- CSS Grid / Flexbox for multi-column layouts
- Inline SVG for diagrams and icons
- Print-friendly `@media print` with page breaks

### Phase 3 — PPT Generation

Once HTML is approved, generate .pptx using `python-pptx`:

```python
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN
from pptx.enum.shapes import MSO_SHAPE
```

Key techniques:
- **New slides**: Create via `python-pptx` script for full control over layout
- **Modify existing**: Use XML manipulation (`slide.shapes._spTree`) for surgical edits
- **Avoid slide deletion**: `python-pptx` slide deletion causes ZIP corruption — generate fresh instead
- **Textbox cleanup**: When replacing content, remove old shape from XML and create new one (don't just `p.clear()` which leaves empty paragraphs)

### Phase 4 — Supporting Assets
- **Excalidraw/diagram extraction**: Read diagram files, extract text elements for narrative

## PPT Tips & Gotchas

| Issue | Solution |
|-------|----------|
| Slide deletion corrupts .pptx | Generate standalone .pptx, let user assemble manually |
| `p.clear()` leaves empty paragraphs | Remove shape from `_spTree`, create new textbox |
| Text overflow | Use `word_wrap = True`, `auto_size = MSO_AUTO_SIZE.NONE` |
| Encoding issues (CJK) | `sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")` |
| Duplicate zip entries | Never mix slide deletion with slide addition in same script |

## Example Commands

```
"Create a presentation about X"
→ Phase 1: outline → Phase 2: HTML → Phase 3: python-pptx

"Convert this HTML to PPT"
→ Skip to Phase 3

"Add a slide to existing PPT"
→ Phase 3 (modification mode)

"Write speaker notes for this deck"
→ Phase 4
```

## Output Files

| File | Purpose |
|------|---------|
| `slides-preview.html` | HTML preview for iteration |
| `generate_slides.py` | python-pptx generation script |
| `output.pptx` | Final PowerPoint file |
