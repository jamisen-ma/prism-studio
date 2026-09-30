# Filter-stack mask research

Primary references checked on 2026-09-19. This records a comparison target and design work, not an implemented feature.

Adobe's [Apply Smart Filters](https://helpx.adobe.com/photoshop/using/applying-smart-filters.html) documents one mask for the complete Smart Filter stack, selective black/white/gray effect coverage, selection-based mask creation, painting, density, feathering, inversion, inspection, disabling and deletion. These controls establish a useful professional workflow to evaluate. The page does not specify a bit-exact interpolation, memory budget or an invertible transform algorithm for Prism to copy.

The first native design should distinguish source-filter effect strength from the separate layer mask that changes coverage. A masked result must retain source alpha, use the completed ordered filter result, and preserve input RGB where mask coverage is zero. It must remain independent of generated content and protected-subject rules. Existing source filter order stays first to last, as already documented; the Adobe stack's displayed ordering is not adopted implicitly.

An exact source-coordinate mask is a promising fit because filters already execute before geometry. Mapping a document selection back to source must have a declared exact subset; arbitrary affine or resampling inversion cannot silently approximate the user's coverage. Later geometry can transform the masked source result normally. Painting requires the same explicit mapping decision.

Persistence needs an explicit rejection path for old readers. A new optional property alone is unsafe if older graph validation ignores it and renders the full stack. The design must cover saved inactive masks too, all stack consumers, metadata-only recipe staging, portable pre-read validation, source editing and Bake.

Adobe's [Smart Objects overview](https://helpx.adobe.com/photoshop/desktop/create-manage-layers/smart-objects/smart-objects-overview-and-benefits.html) separately describes embedded/linked source objects and dependent instances. A native filter mask would not establish those capabilities or justify calling the raster stack a Smart Object.

See [candidate native design](FILTER_MASK_DESIGN.md) and [independent review](FILTER_MASK_REVIEW.md). Neither artifact authorizes a pixel-equivalence claim.
