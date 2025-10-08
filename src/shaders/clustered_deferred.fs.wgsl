// Clustered Deferred - G-buffer fragment shader

@group(${bindGroup_material}) @binding(0) var diffuseTex: texture_2d<f32>;
@group(${bindGroup_material}) @binding(1) var diffuseTexSampler: sampler;

struct FragmentInput
{
    @location(0) pos: vec3f,
    @location(1) nor: vec3f,
    @location(2) uv: vec2f
}

struct GBufferOutputs {
    @location(0) posWorld: vec4f,
    @location(1) norWorld: vec4f,
    @location(2) albedo: vec4f
}

@fragment
fn main(in: FragmentInput) -> GBufferOutputs
{
    let diffuseColor = textureSample(diffuseTex, diffuseTexSampler, in.uv);
    if (diffuseColor.a < 0.5f) {
        discard;
    }

    var out: GBufferOutputs;
    out.posWorld = vec4f(in.pos, 1.0);
    out.norWorld = vec4f(normalize(in.nor), 1.0);
    out.albedo = vec4f(diffuseColor.rgb, 1.0);
    return out;
}
