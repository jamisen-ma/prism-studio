# Individual source-filter blending

Research and design stage, September 19, 2026. Add Noise is complete; no filter-blend implementation is claimed by this note.

Adobe documents editable blending options for individual Smart Filters, including independent hiding and reordering. Its mask applies to the whole Smart Filter stack, rather than one individual filter. These are useful workflow references; Prism's source stacks do not implement Smart Objects. [Adobe Smart Filter documentation](https://helpx.adobe.com/photoshop/using/applying-smart-filters.html).

The W3C specification defines blend functions independently of source/destination alpha. Multiply, Screen and the separable/nonseparable families provide public mathematical references. Prism already has a pure RGB helper for layers and clipping, alongside a separate alpha-compositing path. A source filter must retain source alpha and use the RGB path, without applying a second source-over alpha operation. [W3C Compositing and Blending Level 1](https://www.w3.org/TR/compositing-1/#blending).

## Candidate scope under review

- Add an optional blend mode to existing source-filter entries, commands and recipes. Keep Normal canonicalized to omission, with unchanged legacy bytes, costs and defaults.
- Evaluate the filter at full strength, blend that candidate with the entry's current input RGB, and then apply filter opacity. Every filter retains its own neighborhood, rounding and source-coordinate rules.
- Reuse the existing 26 RGB modes that do not require Dissolve's alpha-coverage policy. Advertise support separately from whole-layer blend modes and from individual filter families.
- Preserve every alpha byte and zero-alpha RGB. Keep protected-target, contextual protection, generated exclusions, source-edit and explicit Bake rules intact.
- Charge nonnormal blend work explicitly, including hidden layers. Revalidate the complete graph before writes and retain bounded event-loop batches without another full-image surface.
- Preserve saved mode through Undo, recipes, portable transfer and reopening. Older readers must reject unknown entry fields rather than silently render a different image.

## Acceptance questions

A computationally unchanged candidate is not necessarily an unchanged blended result. For example, multiplying a zero-strength blur candidate by its input still darkens the RGB. Such candidates can avoid a Gaussian ring or noise sampler, but cannot bypass the blend stage. Disabled entries and zero filter opacity remain complete bypasses.

Normal must keep the current byte-space opacity expression. Nonnormal modes need defined precision around half-byte boundaries, discrete channel ties and clipped values; algebraically equivalent normalized formulas can round differently. Independent probes must cover those boundaries before the new policy is frozen. Existing whole-layer and clipping algorithms are outside this change.

The browser must distinguish filter blending from whole-layer blending. Missing new capabilities leave legacy Normal usable, while unsupported saved nonnormal entries remain readable and their execution/reordering is blocked. Drafts must survive capability withdrawal without silently changing their mode. Capture/import stay definition-only; recipe execution checks all saved modes. Existing late-result and revision guards remain required.

See the [native design](FILTER_BLEND_DESIGN.md), [independent review](FILTER_BLEND_REVIEW.md) and [UI design](FILTER_BLEND_UI_DESIGN.md) as those evaluations progress.
