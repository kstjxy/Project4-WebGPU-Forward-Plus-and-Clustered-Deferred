// Toon shading with edge detection (compute post-process)

@group(0) @binding(0) var inputColor: texture_2d<f32>;
@group(0) @binding(1) var inputDepth: texture_depth_2d;
@group(0) @binding(2) var outputTex: texture_storage_2d<rgba8unorm, write>;
struct PPUniforms {
    levels: f32,
    threshold: f32,
    _pad: vec2f,
}
@group(0) @binding(3) var<uniform> pp: PPUniforms;

fn rgb2lum(c: vec3f) -> f32 {
    return dot(c, vec3f(0.299, 0.587, 0.114));
}

fn quantize_color(c: vec3f, levels: f32) -> vec3f {
    // quantize luminance and rescale color
    let lum = max(rgb2lum(c), 1e-5);
    let qlum = floor(lum * levels) / levels;
    return c * (qlum / lum);
}

@compute
@workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
    let dims = textureDimensions(inputColor);
    if (gid.x >= dims.x || gid.y >= dims.y) {
        return;
    }

    let coord = vec2i(gid.xy);

    // Read color (nearest)
    let color = textureLoad(inputColor, coord, 0).rgb;

    // Sobel on depth for edges
    let w = i32(dims.x);
    let h = i32(dims.y);
    let x = i32(coord.x);
    let y = i32(coord.y);

    let xm1 = max(x - 1, 0);
    let xp1 = min(x + 1, w - 1);
    let ym1 = max(y - 1, 0);
    let yp1 = min(y + 1, h - 1);

    let d00 = textureLoad(inputDepth, vec2i(xm1, ym1), 0);
    let d01 = textureLoad(inputDepth, vec2i(x,   ym1), 0);
    let d02 = textureLoad(inputDepth, vec2i(xp1, ym1), 0);
    let d10 = textureLoad(inputDepth, vec2i(xm1, y  ), 0);
    let d11 = textureLoad(inputDepth, vec2i(x,   y  ), 0);
    let d12 = textureLoad(inputDepth, vec2i(xp1, y  ), 0);
    let d20 = textureLoad(inputDepth, vec2i(xm1, yp1), 0);
    let d21 = textureLoad(inputDepth, vec2i(x,   yp1), 0);
    let d22 = textureLoad(inputDepth, vec2i(xp1, yp1), 0);

    let gx = (d02 + 2.0 * d12 + d22) - (d00 + 2.0 * d10 + d20);
    let gy = (d20 + 2.0 * d21 + d22) - (d00 + 2.0 * d01 + d02);
    let edge = abs(gx) + abs(gy);

    // Quantize color
    let levels = 4.0; // toon bands
    var toon = quantize_color(color, max(pp.levels, 1.0));

    // Edge threshold (tune as needed)
    if (edge > pp.threshold) {
        toon = vec3f(0.0);
    }

    textureStore(outputTex, coord, vec4f(toon, 1.0));
}
