# Colors per object: painted 3MF and one head per color of each object

## Goal

1. **Painted models keep their colors.** Bambu Studio and Orca store
   multicolor painting per triangle (`paint_color`; PrusaSlicer:
   `slic3rpe:mmu_segmentation`). Nothing reads it today: a painted model
   shows and slices in its object's single color.
2. **Each object chooses the head of each of its colors.** Today the color →
   head choice is kept per file: the objects of one 3MF (or two copies of an
   STL) always share it.

Filaments stay managed on the printer (Printers → heads and spools).
Prepare only reads the spools loaded to color the head buttons.

## Example: `cute_dumpling_key.3mf` (MakerWorld, Bambu Studio)

Five filaments (`#F2D5B5 #FFFFFF #000000 #FFCAFF #AEFFFF`), three objects
all declared on extruder 1:

| Object | Triangles | Colors |
|---|---|---|
| Dumpling | 53,058 | painted: body 5, eyes 3, highlights 2, cheeks 4 |
| base key | 27,418 | 1 |
| TAPA 2.0 | 59,536 | 1 |

The file itself is not committed (the designer's license does not allow
it): tests build small painted 3MF files instead.

## The paint encoding

From Orca's `TriangleSelector::deserialize`. The attribute is a hex string
read **from its last character to its first**, one nibble per character:

- `code & 0b11` = number of split sides; 0 is a leaf, otherwise the node
  has `sides + 1` children, which follow depth-first.
- Leaf: `code >> 2` is the state when below 3; `0b1100` means "3 or more":
  the next nibbles give `state - 3`, each `0b1111` adding 15.
- State 0 is "the volume's own extruder"; state `n` is filament `n`.

Splitting depends on the triangle's vertex order.

## Decisions

- **Model color of a triangle** (display, mapping): its dominant painted
  state (children weigh `1 / children` of their parent), otherwise its
  volume's extruder.
- **Colors of an object**: every state its paint uses, plus its volumes'
  extruders — not only the dominant ones, so a fine stroke inside split
  triangles still gets a head.
- **Slicing keeps the paint**: the geometry stays one part per volume head
  (as today), and each triangle's paint is written back as `paint_color`
  with its states renumbered to the destination heads. Splitting painted
  triangles into separate parts would make open meshes.
- **Mirrored objects** (negative scale): we flip the winding by swapping two
  vertices, which would move fine paint; split triangles are written with
  their dominant state instead. Whole-triangle paint is exact.
- **Display**: dominant color per triangle; fine paint inside a large
  triangle is printed but not drawn (exact subdivision display later).
- **Per object**: each plate object keeps its own `heads` (`{ color: head }`),
  saved with the plate, copied by Duplicate. A color without a choice
  falls back to the file's (Slice sheet memory) then to the closest spool,
  as today.
- **Inspector**: the object list becomes a tree, each object's colors under
  it, each with the head buttons T0…T3 in the spool's colors. The floating
  color strip goes away.
- **Slice sheet**: its color table (read-only, edited in Prepare) lists
  objects instead of files; identical objects are grouped.

## Steps

1. **Paint decoding** — `paint.rs`: decode, states used, dominant state,
   renumbering, flattening; tests (simple, split, states ≥ 3 and ≥ 18,
   round trip).
2. **Reading** — `mesh.rs`: `paint_color` / `mmu_segmentation` per triangle;
   `MeshData` carries each triangle's volume extruder and paint; model
   colors paint-aware; plate items and `slice_model` list every color used.
3. **Writing** — `write3mf.rs` writes `paint_color`; `plate.rs` (plate
   scene, plate save) and `slice.rs` keep the paint, renumbered; mirror
   handled. Tests: painted file → scene 3MF → read back with the expected
   states. Real slice of the dumpling file: tool changes on the chosen
   heads.
4. **Prepare** — per-object heads, tree in the inspector, live colors
   from the object's choice, saved plate migrated (colors refreshed),
   Duplicate copies the choice.
5. **Slice sheet** — per-object rows from Prepare; `extruder_map` sent per
   object.
6. **Docs and review** — i18n en/fr, harness screenshots (tree, slice
   sheet), README.

## Out of scope for now

- Exact display of subdivided paint.
- PrusaSlicer's per-volume extruders (`Slic3r_PE_model.config`) and
  filament colors (`Slic3r_PE.config`).
- Color changes at a height (`custom_gcode_per_layer.xml`).
- The AI keeping a painted model's paint when it edits it.
