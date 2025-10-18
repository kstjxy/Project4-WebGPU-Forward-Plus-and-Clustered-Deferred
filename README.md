WebGL Forward+ and Clustered Deferred Shading
======================
**University of Pennsylvania, CIS 565: GPU Programming and Architecture, Project 4**

* Author: Crystal Jin
  *  [LinkedIn](https://www.linkedin.com/in/xiaoyue-jin), [personal website](https://xiaoyuejin.com)

* Tested on: Windows 11, i7-14700K @ 3.40GHz, 64GB RAM, NVIDIA GeForce RTX 4080 SUPER

### Live Demo
[![](img/thumb.png)](http://TODO.github.io/Project4-WebGPU-Forward-Plus-and-Clustered-Deferred)
### Demo Video/GIF
[![](img/video.mp4)](TODO)
### (TODO: Your README)
*DO NOT* leave the README to the last minute! It is a crucial part of the
project, and we will not be able to grade you without a good README.
This assignment has a considerable amount of performance analysis compared
to implementation work. Complete the implementation early to leave time!
### Credits
- [Vite](https://vitejs.dev/)
- [loaders.gl](https://loaders.gl/)
- [dat.GUI](https://github.com/dataarts/dat.gui)
- [stats.js](https://github.com/mrdoob/stats.js)
- [wgpu-matrix](https://github.com/greggman/wgpu-matrix)

Feature Description
-------------------

Naive (Forward)
- Camera uniforms: per‑frame view‑projection matrix uploaded and bound to the vertex stage.
- Vertex output: world position, normal, UV forwarded to fragment.
- Alpha cutoff: discards fragments with low alpha for masked materials.
- Lighting: fragment loops over every light in a storage buffer; uses physically‑reasonable distance falloff with a hard radius clamp.

Forward+ (Clustered Forward)
- Light clustering compute: partitions the view frustum into a 3D grid (XY tiles in NDC, Z slices via logarithmic splitting).
- Cluster bounds: reconstructs each cluster’s 8 NDC corners to view space with the inverse projection, builds a view‑space AABB.
- Light assignment: transforms light positions to view space and assigns them to clusters using an efficient AABB–sphere overlap; stores per‑cluster light lists in a flat [count, indices…] buffer.
- Shading: fragment computes its cluster from fragCoord and view‑space Z (with Y flip for screen→NDC), then accumulates only that cluster’s lights.
- Host wiring: new storage buffer for cluster lists; dispatches the clustering pass before the geometry pass; tunable clusterCountX/Y/Z and maxLightsPerCluster.
- Polish: fixed banding by matching Y conventions; constants aligned with reference; optional toon post‑process can be applied after shading.

Clustered Deferred
- Reuses Forward+ clustering: same compute pass and cluster light list.
- G‑buffer pass: geometry writes
  - Position (world) to rgba16float
  - Normal (world, normalized) to rgba16float
  - Albedo (base color) to rgba8unorm
  - Depth to depth24plus
- Fullscreen lighting: a fullscreen triangle samples the G‑buffer, computes the cluster from screen coords + view‑space Z, and shades using only that cluster’s lights.
- Presentation: renders to an offscreen color target; optional toon post‑process (banded ramp + depth‑edge outlines) runs as a compute pass; final copy to the canvas.
- Robustness: correct UV Y‑flip in fullscreen, Y‑flip in cluster indexing, and nearest sampling for exact G‑buffer fetches.

Toon Shading (Extra Credit)
---------------------------

Overview
- Applies a post‑process toon effect on top of Forward+ and Clustered Deferred.
- Combines band‑limited “ramp” shading with simple edge outlines from depth discontinuities.

Pipeline
- Renders the scene into an offscreen color target and depth.
- Runs a compute pass that reads color + depth and writes a stylized image.
- Presents the result via a lightweight fullscreen copy pass.
- Toggleable at runtime; you can switch it on/off without changing the main renderer.

Algorithm
- Ramp shading: quantizes luminance into a configurable number of bands, then rescales the original color to preserve hue/saturation while flattening shading.
- Edges: Sobel filter on the depth texture using 3×3 neighborhood; if gradient magnitude exceeds a threshold, the pixel is colored black to form outlines.

Controls
- Enabled: turns the toon post‑process on/off.
- Levels: number of luminance bands (integer).
- Edge Threshold: sensitivity of the depth‑based edge detector (lower = more/stronger outlines).
- GUI wiring: `src/main.ts` updates the active renderer’s toon uniforms; both Forward+ and Clustered Deferred implement setters.

Implementation Notes
- Compute shader: `src/shaders/post_processing.cs.wgsl`
  - Inputs: `texture_2d<f32>` color, `texture_depth_2d` depth
  - Output: `texture_storage_2d<rgba8unorm, write>`
  - Uniforms: levels, threshold
  - Workgroup size: 8×8
- Forward+: `src/renderers/forward_plus.ts` renders to an offscreen `rgba8unorm`, runs the compute pass when enabled, then presents either the toon output or the original scene color.
- Clustered Deferred: `src/renderers/clustered_deferred.ts` follows the same pattern after the fullscreen lighting pass.
- Fullscreen copy shaders: `src/shaders/fullscreen_copy.vert.wgsl` and `src/shaders/fullscreen_copy.frag.wgsl`
- GUI setup: `src/main.ts`

Performance
- The compute pass is a single full‑resolution dispatch; cost scales with screen size.
- Nearest sampling keeps the result crisp; using half‑resolution for the compute pass can reduce cost if needed.

Limitations and Extensions
- Depth‑only edges can miss intra‑surface edges; adding normal‑ and/or albedo‑based edges from the G‑buffer improves line quality.
- Quantization is uniform in luminance; a custom ramp texture would enable art‑directed banding/colors.

Performance Analysis
--------------------

Summary
- Clustered Deferred is consistently faster than Forward+ across all light counts tested, and the gap widens as lights increase.
- Forward+ is a big win over Naive, but becomes fragment-cost bound with high light counts and overdraw; Deferred shifts work to a memory/bandwidth pattern that scales better with many lights.

Which Is Faster?
- Clustered Deferred wins everywhere in the data. Example speedups versus Forward+:
  - 500 lights: 4.70 → 3.47 ms (≈1.35× faster)
  - 3000 lights: 28.57 → 8.70 ms (≈3.28× faster)
  - 5000 lights: 45.45 → 15.38 ms (≈2.95× faster)

Why Deferred Wins Here
- Overdraw and light loops: Forward+ shades per-fragment on geometry. With overdraw, the same pixel may be shaded multiple times, each time looping that pixel’s cluster lights. Deferred writes an inexpensive G-buffer first, then shades once per pixel in a fullscreen pass.
- Work rebalancing: Deferred trades ALU for bandwidth (G-buffer writes + reads). In Sponza with many lights, the bandwidth cost scales more gently than repeating the clustered lighting loop under overdraw.
- Cache behavior: Deferred’s fullscreen lighting loops tightly over per-pixel data; Forward+ mixes texture/material sampling with lighting in geometry passes, which can be less cache-friendly at scale.

Workload Suitability
- Clustered Deferred is better when:
  - Many dynamic point lights and significant overdraw.
  - Materials are varied but you can standardize shading in a single fullscreen pass.
  - You can afford G-buffer memory/bandwidth.
- Forward+ can be preferable when:
  - Fewer lights or low overdraw (thin geometry), where the extra G-buffer pass becomes overhead.
  - Transparency and MSAA are important (deferred complicates both).
  - Bandwidth-constrained hardware (mobile) where G-buffer writes/reads dominate.

Benefits and Tradeoffs
- Forward+
  - Simple material path (one pass), natural with transparency.
  - Lower bandwidth than deferred.
  - Scales worse with overdraw + high light counts.
- Clustered Deferred
  - Best scaling with many lights, once-per-pixel lighting.
  - Easier to add post-process/global effects.
  - Higher bandwidth + memory footprint (multiple render targets).
  - Transparency/MSAA more complex.

Implementation Notes That Affect Performance
- Clustering
  - Logarithmic Z slicing reduces light over-assignment near the camera.
  - AABB vs sphere overlap in view space avoids expensive frustum tests.
  - Flat cluster list layout [count, indices…] enables linear memory access in lighting.
- Fragment clustering index
  - Y flip in the fragment/FS passes matches compute tiling and avoids mis-binning/banding (prevents wasted light lookups).

Feature Analysis: Toon Shading
- Overview: Compute pass that quantizes luminance into bands and overlays depth-based Sobel edges.
- Expected performance change: Adds a full-screen compute dispatch; overhead scales with resolution. Measure ms at the target res with Enabled off vs on (levels/threshold held constant).
- Parameters that affect performance:
  - Resolution (linear).
  - Levels: has negligible cost (it’s a few ALU ops).
  - Edge threshold: no cost change; only affects which pixels become black.

Credits
-------
- Vite, loaders.gl, dat.GUI, stats.js, wgpu-matrix
